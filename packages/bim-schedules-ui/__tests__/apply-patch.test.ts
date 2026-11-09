import { applyRowPatch } from "../src/apply-patch";
import type { ColumnValues, RowSet, RowSetColumn } from "../src/contracts";

const COLUMNS: readonly RowSetColumn[] = [
  { id: "mark", heading: "Mark", kind: "field", valueType: "text", writer: { scope: "instance" } },
  { id: "flow", heading: "Flow", kind: "field", valueType: "quantity", quantityKind: "flow_liquid", writer: { scope: "instance" } },
  { id: "on", heading: "On", kind: "field", valueType: "boolean", writer: { scope: "instance" } },
];

function build(rows: { key: string; mark: string | null; flow: number; on: boolean | null }[], revision = 1): RowSet {
  const values = new Map<string, ColumnValues>([
    ["mark", { type: "text", values: rows.map((r) => r.mark) }],
    ["flow", { type: "quantity", kind: "flow_liquid", values: Float64Array.from(rows.map((r) => r.flow)) }],
    ["on", { type: "boolean", values: Int8Array.from(rows.map((r) => (r.on === null ? -1 : r.on ? 1 : 0))) }],
  ]);
  return { viewId: "v", revision, columns: COLUMNS, rowCount: rows.length, rowKeys: rows.map((r) => r.key), elementIds: rows.map((r) => `el-${r.key}`), values, children: new Map() };
}

function plain(rs: RowSet) {
  return {
    revision: rs.revision,
    rowKeys: [...rs.rowKeys],
    elementIds: [...rs.elementIds],
    values: Object.fromEntries([...rs.values].map(([k, v]) => [k, Array.from(v.values as ArrayLike<unknown>)])),
  };
}

describe("applyRowPatch", () => {
  const base = build([
    { key: "a", mark: "P-1", flow: 1, on: true },
    { key: "b", mark: "P-2", flow: 2, on: false },
    { key: "c", mark: "P-3", flow: 3, on: null },
  ]);

  it("a value-only patch equals the rebuilt row set and leaves the original untouched", () => {
    const next = applyRowPatch(base, { viewId: "v", fromRevision: 1, toRevision: 2, upserts: [{ rowKey: "b", elementId: "el-b", values: { flow: 9, on: true } }], removes: [] });
    expect(plain(next)).toEqual(plain(build([{ key: "a", mark: "P-1", flow: 1, on: true }, { key: "b", mark: "P-2", flow: 9, on: true }, { key: "c", mark: "P-3", flow: 3, on: null }], 2)));
    expect(base.values.get("flow")?.values[1]).toBe(2);
    // Untouched columns are shared, not copied.
    expect(next.values.get("mark")).toBe(base.values.get("mark"));
  });

  it("inserts, removes and a new order equal the rebuilt row set", () => {
    const next = applyRowPatch(base, {
      viewId: "v",
      fromRevision: 1,
      toRevision: 2,
      upserts: [{ rowKey: "d", elementId: "el-d", values: { mark: "P-4", flow: 4, on: false } }],
      removes: ["a"],
      order: ["d", "c", "b"],
    });
    expect(plain(next)).toEqual(
      plain(
        build(
          [
            { key: "d", mark: "P-4", flow: 4, on: false },
            { key: "c", mark: "P-3", flow: 3, on: null },
            { key: "b", mark: "P-2", flow: 2, on: false },
          ],
          2,
        ),
      ),
    );
  });

  it("ignores a patch for another schedule", () => {
    expect(applyRowPatch(base, { viewId: "other", fromRevision: 1, toRevision: 2, upserts: [], removes: ["a"] })).toBe(base);
  });
});
