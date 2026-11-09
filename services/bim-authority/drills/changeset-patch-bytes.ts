/**
 * Changeset patches on a real model's history, read only (round 5a, f-wire):
 * walks every stored changeset of a model in revision order, writes each as a
 * patch against the records the walk has seen so far, replays the patch and
 * checks it equals the stored full body. Prints body and patch bytes per edit
 * for `authority.commit.bytes_per_edit`.
 *
 * Elements first seen in the walk have no earlier record here (they were
 * loaded before the first stored changeset) and are stored whole, so the
 * patch figure is an upper bound.
 *
 *   BIM_PATCH_DRILL_DB_URL=postgresql://postgres:postgres@127.0.0.1:54732/mutinybim \
 *   node --import tsx services/bim-authority/drills/changeset-patch-bytes.ts site-7352 site-7903
 */
import { canonicalJson, type BimElement, type Changeset } from "@permitzip/bim-kernel";
import { changesetPatch, jsonBytes, replayChangesetPatch } from "@permitzip/bim-sync";
import { connect } from "../src/pg-store";

const url = process.env.BIM_PATCH_DRILL_DB_URL;
if (!url) throw new Error("Set BIM_PATCH_DRILL_DB_URL to the model database (read only)");
const modelIds = process.argv.slice(2);
const sql = connect(url, 1);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)] ?? Number.NaN;
}

let ok = true;
for (const modelId of modelIds.length > 0 ? modelIds : ["site-7352"]) {
  const rows = await sql.begin("isolation level repeatable read read only", (tx) => tx<{ body: Changeset }[]>`
    select body from bim.changesets where model_id = ${modelId} order by revision`);
  const seen = new Map<string, BimElement>();
  const body: number[] = [];
  const patch: number[] = [];
  let mismatches = 0;
  for (const { body: cs } of rows) {
    const p = changesetPatch(cs, (id) => seen.get(id));
    const replayed = replayChangesetPatch(p, (id) => seen.get(id));
    if (canonicalJson(replayed) !== canonicalJson(cs)) mismatches += 1;
    body.push(jsonBytes(cs));
    patch.push(jsonBytes(p));
    for (const el of cs.elements) seen.set(el.id, el);
    for (const id of cs.removedIds ?? []) seen.delete(id);
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  console.log(
    `${modelId}: ${rows.length} changesets; body ${Math.round(sum(body) / Math.max(1, rows.length))} B/edit (median ${median(body)}, p95 ${p95(body)}), patch ${Math.round(sum(patch) / Math.max(1, rows.length))} B/edit (median ${median(patch)}, p95 ${p95(patch)}); replay mismatches ${mismatches}`,
  );
  if (mismatches > 0) ok = false;
}
console.log(ok ? "PASS: every patch replays to its stored body" : "FAIL");
await sql.end();
process.exit(ok ? 0 : 1);
