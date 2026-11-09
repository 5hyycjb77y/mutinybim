/**
 * Paged boot against a real model database, read only (round 5a, f-wire):
 * loads a model's head the old way (one unbounded `select body`) and through
 * pages (the authority's loader), at the default page size and at a small
 * one that forces many pages, and checks all three hold exactly the same
 * elements. Prints the timings for `authority.boot.7352`.
 *
 * Every statement runs in a read-only transaction; it writes nothing.
 *
 *   BIM_BOOT_DRILL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54732/mutinybim \
 *   node --import tsx services/bim-authority/drills/paged-boot.ts site-7352
 *
 * With BIM_BOOT_DRILL_ADDONS=1 it also times the open with Structural and Civil switched on
 * (`authority.boot.7352.two_addons_on`).
 */
import { canonicalJson, executeCommand, warmModel, withUpgradePolicy, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { SERVER_FEATURES } from "@permitzip/bim-sync";
import { unbindModelPacks, withModelPacks } from "@permitzip/bim-kernel/packs";
import { BOOT_PAGE_SIZE, connect, loadHeadTimed } from "../src/pg-store";
import { INSTALLED_PACKS, bindServedModelState, ensureFirstPartyAddOns } from "../src/packs";

const url = process.env.BIM_BOOT_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_BOOT_DRILL_DB_URL to the model database (read only)");
const modelId = process.argv[2] ?? "site-7352";
const runs = Number(process.argv[3] ?? "7");

const sql = connect(url, 1);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

async function fullBoot(): Promise<{ ms: number; hash: string; count: number }> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    // The boot before round 5a: model row, every element in one statement, connections.
    const t0 = performance.now();
    await tx`select revision, lease_generation, settings, created_at::text as epoch from bim.models where id = ${modelId}`;
    const rows = await tx<{ body: BimElement }[]>`select body from bim.elements where model_id = ${modelId}`;
    await tx`select connection_id, a_element, a_end, b_element, b_end from bim.connections where model_id = ${modelId} order by ordinal`;
    const elements = Object.fromEntries(rows.map((r) => [r.body.id, r.body]));
    return { ms: performance.now() - t0, hash: canonicalJson(elements), count: rows.length };
  });
}

async function pagedBoot(pageSize: number): Promise<{ ms: number; hash: string; count: number; pages: number }> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const t0 = performance.now();
    const { head, timings } = await loadHeadTimed(tx, modelId, pageSize);
    return { ms: performance.now() - t0, hash: canonicalJson(head.model.elements), count: timings.elements, pages: timings.pages };
  });
}

const full: number[] = [];
const paged: number[] = [];
let reference = "";
let ok = true;
for (let i = 0; i < runs; i++) {
  const f = await fullBoot();
  const p = await pagedBoot(BOOT_PAGE_SIZE);
  const small = await pagedBoot(25);
  if (i === 0) {
    reference = f.hash;
    console.log(`${modelId}: ${f.count} elements; default page size ${BOOT_PAGE_SIZE} -> ${p.pages} page(s); page size 25 -> ${small.pages} pages`);
  }
  for (const [name, r] of [["paged", p], ["paged-25", small]] as const) {
    if (r.hash !== reference || r.count !== f.count) {
      ok = false;
      console.error(`MISMATCH: ${name} boot differs from the full boot (${r.count} vs ${f.count} elements)`);
    }
  }
  full.push(f.ms);
  paged.push(p.ms);
}
console.log(`full boot (one statement): median ${median(full).toFixed(1)} ms over ${runs}`);
console.log(`paged boot: median ${median(paged).toFixed(1)} ms over ${runs}`);

// `authority.boot.7352.two_addons_on` (round 8): the server's open (paged load, bind the model's
// add-on set, warm-up under it) with Structural and Civil switched on, against the same open with
// them off. The switches are applied in memory only; nothing is written.
if (process.env.BIM_BOOT_DRILL_ADDONS === "1") {
  ensureFirstPartyAddOns();
  // The two setup records a head with both switched on holds, made once through the kernel's own
  // command under this server's features; each open then reads them as if they were stored rows.
  const setupRecords = await sql.begin("isolation level repeatable read read only", async (tx) => {
    const loaded = (await loadHeadTimed(tx, modelId, BOOT_PAGE_SIZE)).head.model;
    const switched = INSTALLED_PACKS.reduce((m: ModelState, pack) => {
      const r = withUpgradePolicy((f) => SERVER_FEATURES.includes(f), () => executeCommand(m, { type: "set_model_addon", packId: pack.manifest.id, version: pack.manifest.version, on: true }));
      if (!r.ok) throw new Error(`switching ${pack.manifest.id} on refused: ${r.error.message}`);
      return r.model;
    }, loaded);
    return Object.fromEntries(Object.entries(switched.elements).filter(([id]) => loaded.elements[id] === undefined));
  });
  const open = async (addonsOn: boolean): Promise<number> =>
    sql.begin("isolation level repeatable read read only", async (tx) => {
      const t0 = performance.now();
      const loaded = (await loadHeadTimed(tx, modelId, BOOT_PAGE_SIZE)).head.model;
      const served: ModelState = { ...loaded, elements: { ...loaded.elements, ...(addonsOn ? structuredClone(setupRecords) : {}) } };
      bindServedModelState(served);
      withModelPacks(modelId, () => warmModel(served));
      const ms = performance.now() - t0;
      unbindModelPacks(modelId);
      return ms;
    });
  const off: number[] = [];
  const on: number[] = [];
  for (let i = 0; i < runs; i++) {
    off.push(await open(false));
    on.push(await open(true));
  }
  const ratio = median(on) / median(off);
  console.log(`open with add-ons off: median ${median(off).toFixed(2)} ms; with ${INSTALLED_PACKS.map((p) => p.manifest.id).join(" + ")} on: median ${median(on).toFixed(2)} ms over ${runs} (${Object.keys(setupRecords).length} setup records); ratio ${ratio.toFixed(3)} (budget <= 1.05)`);
  if (ratio > 1.05) ok = false;
}
console.log(ok ? "PASS: paged boot equals full boot" : "FAIL");
await sql.end();
process.exit(ok ? 0 : 1);
