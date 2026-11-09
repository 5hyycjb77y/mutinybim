/**
 * Round 10 lane P10: the pipe catalogue read through the Plumbing add-on's
 * product rows. The tier's full-building model with a synthetic cold water
 * system laid on it (copper trunks and branches) and a stored elbow at the
 * end of every piece, its joint as the kernel chose it.
 *
 * - pipes.lift.stored: what opening a stored model reads (inside
 *   `authority.boot`): every pipe fitting's joint as its end type and every
 *   pipe piece's product, on a fresh pack set (its product and end-type
 *   tables built inside the timing).
 * - pipes.joint_issue.edit_50: `jointIssue` on the 50 fittings one edit touches.
 * - pipes.sizing.edit_50: dimensions, product and size check on the 50 pieces one edit touches.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/pipe-products.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line.
 */
import { asElementId, elementValues, elementsOfKind, fittingFamily, freezeElements, jointIssue, liftPipeJoints, pipeDims, pipeParams, pipeSizeIssue, resolveParams, specOfSize, syntheticPlumbing, type BimElement, type Level, type ModelState, type RunFitting, type RunSegment } from "@permitzip/bim-kernel";
import { PackSet, installedFirstPartyPacks, withPackSet } from "@permitzip/bim-kernel/packs";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { emit, gc, memoryMB, timeSync, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const TRUNKS = tier === "1M" ? 200 : 50;
const BRANCHES = 100;
const EDIT = 50;

/** The open read: every pipe fitting's joint as its add-on end type (`liftPipeJoints`) and every pipe piece's product. Counts what it found. */
function openRead(model: ModelState): number {
  let n = 0;
  const fittings = elementsOfKind(model.elements, "run_fitting");
  for (const endType of liftPipeJoints(fittings).values()) if (endType !== undefined) n += 1;
  for (const f of fittings) {
    const size = f.ports[0]?.size;
    if (f.domain === "pipe" && size?.shape === "pipe" && specOfSize(size)) n += 1;
  }
  for (const s of elementsOfKind(model.elements, "run_segment")) if (s.size.shape === "pipe" && specOfSize(s.size)) n += 1;
  return n;
}

function main(): void {
  installFirstPartyAddOns();
  const base = createFullBimModel(opts);
  const existing = elementValues(base.elements).find((e) => e.kind === "level");
  const level: Level = existing?.kind === "level" ? existing : { id: asElementId("synp-level"), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const syn = syntheticPlumbing({ levelId: level.id, trunks: TRUNKS, branchesPerTrunk: BRANCHES });
  const elbow = fittingFamily("pipe.water.elbow_90");
  if (!elbow) throw new Error("[perf/pipe-products] no pipe.water.elbow_90");
  const elbows: Record<string, BimElement> = {};
  for (const el of Object.values(syn.elements)) {
    if (el.kind !== "run_segment" || el.size.shape !== "pipe") continue;
    const id = asElementId(`${el.id}-elbow`);
    const ports = [{ id: "a", position: el.end, direction: { x: -1, y: 0, z: 0 }, size: el.size }, { id: "b", position: el.end, direction: { x: 0, y: 1, z: 0 }, size: el.size }];
    elbows[id] = { id, kind: "run_fitting", version: 0, authoredRev: {}, fittingType: "elbow", label: elbow.name, domain: "pipe", systemId: el.systemId, levelId: el.levelId, position: el.end, angleDeg: 90, ports, family: elbow.id, params: resolveParams(elbow, pipeParams(elbow, el.size, undefined)) } satisfies RunFitting;
  }
  const model: ModelState = { ...base, elements: freezeElements({ ...base.elements, [level.id]: level, ...syn.elements, ...elbows }) };
  const totalElements = Object.keys(model.elements).length;
  const fittings: RunFitting[] = elementsOfKind(model.elements, "run_fitting").filter((f) => f.domain === "pipe" && f.family !== undefined);
  const pieces: RunSegment[] = elementsOfKind(model.elements, "run_segment").filter((s) => s.size.shape === "pipe");
  if (fittings.length < EDIT || pieces.length < EDIT) throw new Error(`[perf/pipe-products] only ${fittings.length} fittings and ${pieces.length} pieces`);
  gc();

  const lift: number[] = [];
  let read = -1;
  for (let i = 0; i < samplesPerRun; i++) {
    const fresh = PackSet.create(installedFirstPartyPacks());
    const t = timeSync(() => withPackSet(fresh, () => openRead(model)));
    lift.push(t.ms);
    if (read >= 0 && t.value !== read) throw new Error("[perf/pipe-products] the open read changed between samples");
    read = t.value;
  }

  const joint: number[] = [];
  let issues = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const from = (i * 977) % (fittings.length - EDIT);
    const batch = fittings.slice(from, from + EDIT);
    const t = timeSync(() => {
      let found = 0;
      for (const f of batch) {
        const family = f.family ? fittingFamily(f.family) : null;
        if (family && jointIssue(family, f.params ?? {}, f.ports[0]?.size)) found += 1;
      }
      return found;
    });
    joint.push(t.ms);
    issues += t.value;
  }

  const sizing: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const from = (i * 977) % (pieces.length - EDIT);
    const batch = pieces.slice(from, from + EDIT);
    const t = timeSync(() => {
      let sum = 0;
      for (const s of batch) {
        if (s.size.shape !== "pipe") continue;
        sum += pipeDims(s.size).idMm + (specOfSize(s.size)?.roughnessMm ?? 0) + (pipeSizeIssue(s.size) === null ? 0 : 1);
      }
      return sum;
    });
    sizing.push(t.ms);
  }

  const counts = { totalElements, networkElements: fittings.length + pieces.length };
  const samples: Sample[] = [
    { metric: "pipes.lift.stored", values: lift, counts, note: `every pipe fitting's joint and every pipe piece's product (${fittings.length} fittings, ${pieces.length} pieces) on a fresh pack set` },
    { metric: "pipes.joint_issue.edit_50", values: joint, counts, note: "jointIssue on the 50 fittings an edit touches" },
    { metric: "pipes.sizing.edit_50", values: sizing, counts, note: "pipeDims, the product and pipeSizeIssue on the 50 pieces an edit touches" },
  ];
  emit({
    suite: "plumbing",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { tier, trunks: TRUNKS, branchesPerTrunk: BRANCHES, samplesPerRun },
    samples,
    invariants: { "pipes.jointIssuesOnSynthetic": issues },
    info: { memory: memoryMB(), openRead: read },
  });
}

try {
  main();
} catch (err) {
  console.error("[perf/pipe-products] failed", err);
  process.exit(1);
}
