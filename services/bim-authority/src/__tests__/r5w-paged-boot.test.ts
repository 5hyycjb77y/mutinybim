/**
 * @jest-environment node
 *
 * Paged boot (round 5a, f-wire): the head read in pages by key holds exactly
 * the elements the one unbounded read did, at any page size, and an
 * overlapping page fails loudly instead of loading a duplicate.
 *
 * Fails on the code before round 5a: `collectPages` did not exist and the
 * boot was a single `select body from bim.elements` with no bound.
 * The same check runs against the real 7352 model in
 * drills/paged-boot.ts (read only).
 */
import { collectPages } from "../paged-load";

interface Row {
  readonly element_id: string;
  readonly body: { readonly id: string; readonly n: number };
}

/** A building's worth of ids in the database's order (a reader supplies it; we never sort in JavaScript). */
const ROWS: Row[] = Array.from({ length: 1_237 }, (_, i) => {
  const id = `el-${String(i).padStart(5, "0")}`;
  return { element_id: id, body: { id, n: i } };
});

function reader(rows: readonly Row[]) {
  const calls: { after: string | null; limit: number }[] = [];
  const fetchPage = async (after: string | null, limit: number) => {
    calls.push({ after, limit });
    const start = after === null ? 0 : rows.findIndex((r) => r.element_id === after) + 1;
    return rows.slice(start, start + limit);
  };
  return { fetchPage, calls };
}

describe("paged boot equals full boot", () => {
  it.each([1, 7, 500, 1_237, 2_000])("page size %i holds every element once, in order", async (pageSize) => {
    const { fetchPage, calls } = reader(ROWS);
    const { rows, pages } = await collectPages(fetchPage, (r) => r.element_id, pageSize);
    expect(rows).toEqual(ROWS);
    expect(pages).toBe(Math.floor(ROWS.length / pageSize) + 1);
    expect(calls.every((c) => c.limit === pageSize)).toBe(true);
    expect(calls[0]?.after).toBeNull();
  });

  it("an empty model is one empty page", async () => {
    const { fetchPage } = reader([]);
    await expect(collectPages(fetchPage, (r) => r.element_id, 2000)).resolves.toEqual({ rows: [], pages: 1 });
  });

  it("fails loudly when pages overlap", async () => {
    const overlapping = async (after: string | null, limit: number) => {
      const start = after === null ? 0 : ROWS.findIndex((r) => r.element_id === after); // repeats the last row
      return ROWS.slice(start, start + limit);
    };
    await expect(collectPages(overlapping, (r) => r.element_id, 100)).rejects.toThrow(/boot pages overlap/);
  });

  it("refuses a page size that would never finish", async () => {
    const { fetchPage } = reader(ROWS);
    await expect(collectPages(fetchPage, (r) => r.element_id, 0)).rejects.toThrow(/positive integer/);
  });
});
