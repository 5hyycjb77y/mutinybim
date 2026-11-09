/**
 * lineage.* in process (round 11 lane L11): forking, landing, comparing and
 * opening long-lived copies at 250k and 1M elements, no network, no Postgres.
 *
 *   node --import tsx scripts/perf/mutinybim/lineages.ts [--elements=250000] [--samples=7]
 *
 * Builds a model of N plain records on the chunked element store, commits
 * 2,000 changesets after a version (each rewriting one record, `before`
 * recorded), then measures:
 *
 *   lineage.fork               a copy 2,000 changesets back (forkLineage + forkState: the same pin as branch.fork)
 *   lineage.land.2k            2,000 records landed on the parent as one revision (landMergePart, the kernel
 *                              half of merge.apply.2k_changed); measured before the lineage code existed
 *   lineage.accept_back.2k     accept 2,000 records of a copy back onto its parent: the three-way merge over
 *                              those records plus the landing (≤ merge.apply.2k_changed)
 *   lineage.compare.diverged_10  the overlay of a copy that rewrote 10 % of the model against its parent
 *   lineage.chain.depth_5.open   materialise a copy five deep from the first lineage's pin and its line
 *                              (5 × 400 changesets); `depth_1` is one copy with the same 2,000 changesets
 *
 * Counts prove each read touched the changed set, not N.
 */
import {
  applyChangeset,
  asElementId,
  asRevision,
  forkState,
  freezeElements,
  landMergePart,
  replayTo,
  type BimElement,
  type Changeset,
  type ElementId,
  type ModelState,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import {
  acceptBack,
  compareLineages,
  forkLineage,
  lineageChain,
  lineageLookup,
  lineageSegments,
  type Lineage,
} from "@permitzip/bim-kernel/lineages";
import { emit } from "./lib";

const args = process.argv.slice(2);
const elementsN = Number(args.find((a) => a.startsWith("--elements="))?.split("=")[1] ?? 250_000);
const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1] ?? 7);
const CHANGES = 2000;
const DIVERGED = Math.floor(elementsN * 0.1);
const PER_CHANGESET = 1000;

function time<T>(fn: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

const AUTHOR = { provider: "unsigned", subject: "perf", kind: "person" } as const;
const demo = createDemoModel("perf-lineage");
// Plain records with no network: a landing validates what it touched, so the workload measures the landing alone.
const record: Record<string, BimElement> = {};
for (let i = 0; i < elementsN; i++) {
  const id = asElementId(`e${i}`);
  record[id] = { id, version: 1, authoredRev: {}, kind: "level", name: `Level ${i}`, elevationMm: i };
}
const version: ModelState = { ...demo, revision: asRevision(0), elements: freezeElements(record), connections: [] };

function commit(model: ModelState, ids: readonly ElementId[], tag: string): { model: ModelState; cs: Changeset } {
  const revision = model.revision + 1;
  const before: Record<string, BimElement | null> = {};
  const elements: BimElement[] = [];
  for (const id of ids) {
    const prior = model.elements[id];
    if (!prior) throw new Error(`missing ${id}`);
    before[id] = prior;
    elements.push({ ...prior, version: prior.version + 1, name: `${tag} ${revision}` } as BimElement);
  }
  const cs: Changeset = { revision: asRevision(revision), baseRevision: model.revision, idempotencyKey: `${tag}-${revision}`, actor: { id: "perf", name: "Perf", kind: "human" }, command: { type: "set_tag_text", tagId: "perf", text: "perf" }, elements, readSet: {}, authored: [], intents: [], rebased: false, committedAt: new Date(0).toISOString(), before };
  return { model: applyChangeset(model, cs), cs };
}

// The design's line: 2,000 one-record changesets after the version.
const changesets: Changeset[] = [];
let head = version;
for (let r = 1; r <= CHANGES; r++) {
  const step = commit(head, [asElementId(`e${(r * 7919) % elementsN}`)], "design");
  head = step.model;
  changesets.push(step.cs);
}

const root: Lineage = { id: "design", parent: null, role: "design_record", returnPolicy: "never", state: "open", name: "Design", createdBy: AUTHOR, createdAt: "2026-11-02T00:00:00Z" };

// --- lineage.fork
const fork: number[] = [];
for (let s = 0; s < samples; s++) {
  fork.push(
    time(() => {
      const lineage = forkLineage({ id: "c1", parent: root, revision: 0, parentHead: head.revision, role: "shop", name: "c1", createdBy: AUTHOR, createdAt: "2026-11-02T00:00:00Z" });
      return { lineage, state: forkState(head, 0, changesets) };
    }).ms,
  );
}

// --- lineage.land.2k (the kernel landing alone)
const landIds: ElementId[] = [...new Set(Array.from({ length: CHANGES }, (_, i) => asElementId(`e${(i * 104729) % elementsN}`)))];
const writes = landIds.map((id) => {
  const prior = head.elements[id];
  if (!prior) throw new Error(`missing ${id}`);
  return { elementId: id, record: { ...prior, version: prior.version + 1 } };
});
const land: number[] = [];
let landed = 0;
for (let s = 0; s < samples; s++) {
  const result = time(() => landMergePart(head, writes));
  land.push(result.ms);
  if (!result.value.ok) throw new Error(`landing refused: ${result.value.error.message}`);
  landed = result.value.changedIds.length;
}

// A copy of the design at its head that rewrites DIVERGED records (10 %), PER_CHANGESET per changeset.
const shop = forkLineage({ id: "shop", parent: root, revision: head.revision, parentHead: head.revision, role: "shop", name: "Shop", createdBy: AUTHOR, createdAt: "2026-11-02T00:00:00Z" });
const lookup = lineageLookup([root, shop]);
let shopHead = head;
const shopChanges: Changeset[] = [];
for (let start = 0; start < DIVERGED; start += PER_CHANGESET) {
  const ids = Array.from({ length: Math.min(PER_CHANGESET, DIVERGED - start) }, (_, k) => asElementId(`e${((start + k) * 9973) % elementsN}`));
  const step = commit(shopHead, [...new Set(ids)], "shop");
  shopHead = step.model;
  shopChanges.push(step.cs);
}
const anchorRevision = head.revision;

// --- lineage.accept_back.2k
const acceptIds = [...new Set(shopChanges.flatMap((cs) => cs.elements.map((e) => e.id)))].slice(0, CHANGES);
const accept: number[] = [];
for (let s = 0; s < samples; s++) {
  const result = time(() => acceptBack({ lookup, child: { lineageId: "shop", head: shopHead, changes: shopChanges }, target: { lineageId: "design", head, changes: [] }, recordIds: acceptIds }));
  accept.push(result.ms);
  if (!result.value.ok || !result.value.landing.ok) throw new Error("accept back refused");
}

// --- lineage.compare.diverged_10
const compare: number[] = [];
let differences = 0;
for (let s = 0; s < samples; s++) {
  const result = time(() => compareLineages(lookup, { lineageId: "design", head, changes: [] }, { lineageId: "shop", head: shopHead, changes: shopChanges }));
  compare.push(result.ms);
  differences = result.value.differences.length;
}

// --- lineage.chain.depth_5.open vs depth_1: materialise the copy from the first lineage's pin through its line.
function chainOf(depth: number): { lineages: Lineage[]; leaf: string } {
  const lineages: Lineage[] = [root];
  let parent = root;
  for (let d = 1; d <= depth; d++) {
    const pin = d === 1 ? 0 : ((d - 1) * CHANGES) / depth;
    const next = forkLineage({ id: `d${d}`, parent, revision: pin, parentHead: CHANGES, role: "proposal", name: `d${d}`, createdBy: AUTHOR, createdAt: "2026-11-02T00:00:00Z" });
    lineages.push(next);
    parent = next;
  }
  return { lineages, leaf: parent.id };
}
// Each lineage owns its slice of the 2,000 changesets; the line is the same records either way.
function open(depth: number): () => ModelState {
  const { lineages, leaf } = chainOf(depth);
  const look = lineageLookup(lineages);
  const own = new Map<string, Changeset[]>();
  return () => {
    const chain = lineageChain(look, leaf);
    const line = lineageSegments(chain, 0, CHANGES).flatMap((seg) => {
      let slice = own.get(seg.lineageId);
      if (!slice) {
        slice = changesets.filter((cs) => cs.revision > seg.from && cs.revision <= seg.to);
        own.set(seg.lineageId, slice);
      }
      return slice;
    });
    return replayTo(version, CHANGES, line, applyChangeset);
  };
}
const open1 = open(1);
const open5 = open(5);
const depth1: number[] = [];
const depth5: number[] = [];
for (let s = 0; s < samples; s++) {
  depth1.push(time(open1).ms);
  depth5.push(time(open5).ms);
}

emit({
  suite: "batch",
  workload: { elements: elementsN, changesetsAfterVersion: CHANGES, diverged: DIVERGED, samples },
  network: "in-process (no network, no Postgres)",
  participants: 1,
  info: { landed, differences, acceptAnchor: anchorRevision },
  samples: [
    { metric: "lineage.fork", values: fork, note: `A copy ${CHANGES} changesets back: forkLineage plus the same pin as branch.fork.` },
    { metric: "lineage.land.2k", values: land, counts: { landedElements: landed }, note: "2,000 records landed on the parent as one revision (landMergePart)." },
    { metric: "lineage.accept_back.2k", values: accept, counts: { acceptedRecords: acceptIds.length }, note: "Accept 2,000 records of a copy back: three-way merge over them plus the landing." },
    { metric: "lineage.compare.diverged_10", values: compare, counts: { differences }, note: `The overlay of a copy that rewrote ${DIVERGED} records (10 %) against its parent.` },
    { metric: "lineage.chain.depth_1.open", values: depth1, note: `One copy: replay its ${CHANGES} changesets from the first lineage's pin.` },
    { metric: "lineage.chain.depth_5.open", values: depth5, note: `A copy five deep over the same ${CHANGES} changesets (400 per lineage): chain walk, segments, replay.` },
  ],
});
