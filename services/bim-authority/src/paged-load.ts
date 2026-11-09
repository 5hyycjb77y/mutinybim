/**
 * Paged boot (KERNEL-AUDIT §6.1): the head's elements are read in pages of
 * `pageSize` by key, inside the caller's one read-only snapshot, instead of
 * one unbounded `select body`. Each page is a bounded index range scan on
 * `elements_pkey (model_id, element_id)`, so no statement holds the whole
 * building in one result.
 *
 * The reader must return rows ordered by key and strictly after `after` in
 * the database's own collation (do not compare keys in JavaScript: en_US and
 * code-unit order disagree on punctuation and case).
 *
 * Pure so the paging itself is tested without a database
 * (`r5w-paged-boot.test.ts`); pg-store.ts supplies the page reader.
 */
export interface PagedRows<R> {
  readonly rows: R[];
  readonly pages: number;
}

export async function collectPages<R>(
  fetchPage: (after: string | null, limit: number) => Promise<readonly R[]>,
  keyOf: (row: R) => string,
  pageSize: number,
): Promise<PagedRows<R>> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error(`[bim-authority] boot page size must be a positive integer, not ${pageSize}`);
  const rows: R[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(after, pageSize);
    pages += 1;
    for (const row of page) {
      // Order is the database's (its collation); a repeated key means the pages overlapped.
      const key = keyOf(row);
      if (seen.has(key)) throw new Error(`[bim-authority] boot pages overlap at "${key}"`);
      seen.add(key);
      rows.push(row);
      after = key;
    }
    if (page.length < pageSize) return { rows, pages };
  }
}
