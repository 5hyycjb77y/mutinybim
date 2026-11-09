/**
 * @jest-environment node
 *
 * Changeset patches (round 5a, f-wire; KERNEL-AUDIT §6.1): the model server
 * writes each changeset both whole and as a patch against the records it
 * replaced, for one release. Replaying every patch over the records before it
 * gives back exactly the full changeset, across placements, moves, parameter
 * edits, deletes with their cut connections, and undo. The patch is smaller
 * than the body for an edit to an existing element.
 *
 * The same replay runs over every stored changeset of the real local models
 * in services/bim-authority/drills/changeset-patch-bytes.ts (read only).
 *
 * Fails on the code before round 5a: there was no patch form, so every
 * changeset carried every changed element's whole body (and its whole
 * `before` record for undo).
 */
import { BUILTIN_PART_TYPES, canonicalJson, type Actor, type Changeset, type Command, type CommandRequest, type LibraryEntry, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { InMemoryCommitStore, Sequencer, changesetPatch, diffRecord, jsonBytes, replayChangesetPatch } from "../src";

const avery: Actor = { id: "user-avery", name: "Avery", kind: "human" };

function libraryType(category: string): LibraryEntry {
  const found = BUILTIN_PART_TYPES.find((t) => t.definition.category === category);
  if (!found) throw new Error(`no ${category} in the starter library`);
  return found;
}
const DIFFUSER = libraryType("air_terminal");

let keys = 0;
async function commit(sequencer: Sequencer, store: InMemoryCommitStore, command: Command): Promise<{ before: ModelState; cs: Changeset }> {
  const before = await store.head();
  keys += 1;
  const request: CommandRequest = { idempotencyKey: `r5w-${keys}`, baseRevision: before.revision, actor: avery, command };
  const outcome = await sequencer.submit(request);
  if (outcome.status !== "committed") throw new Error(`not committed: ${JSON.stringify(outcome)}`);
  const cs = (await store.changesSince(before.revision))[0];
  if (!cs) throw new Error("no changeset");
  return { before, cs };
}

describe("patch replay equals the full changeset", () => {
  it("over a run of real edits, including a delete and an undo", async () => {
    const store = new InMemoryCommitStore(createDemoModel());
    const sequencer = await Sequencer.start(store);
    const commands: Command[] = [
      { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 },
      { type: "place_part", partId: "p-1", typeId: DIFFUSER.id, partType: DIFFUSER.definition, levelId: "lvl-1", position: { x: 2000, y: 1000 }, offsetMm: 2743 },
      { type: "move_elements", ids: ["p-1"], delta: { x: 500, y: 0 } },
      { type: "set_parameters", id: "p-1", scope: "instance", values: { airflow: 95 } },
      { type: "update_level", levelId: "lvl-1", name: "Ground floor" },
      { type: "slide_branch", tapId: "tap-1", s: 3048 },
    ];
    const results: { before: ModelState; cs: Changeset }[] = [];
    for (const command of commands) results.push(await commit(sequencer, store, command));
    // Undo the latest edit (the slide), then delete the part.
    results.push(await commit(sequencer, store, { type: "undo", revision: results[results.length - 1]?.cs.revision ?? -1 }));
    results.push(await commit(sequencer, store, { type: "delete_elements", ids: ["p-1"], policy: "disconnect" }));
    expect(results.map((r) => r.cs.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    let bodyBytes = 0;
    let patchBytes = 0;
    for (const { before, cs } of results) {
      const patch = changesetPatch(cs, (id) => before.elements[id]);
      // Through JSON, as the database stores and returns it.
      const stored = JSON.parse(JSON.stringify(patch));
      const replayed = replayChangesetPatch(stored, (id) => before.elements[id]);
      expect(canonicalJson(replayed)).toBe(canonicalJson(cs));
      if (cs.elements.every((el) => before.elements[el.id])) {
        bodyBytes += jsonBytes(cs);
        patchBytes += jsonBytes(patch);
      }
    }
    // Edits to existing elements: the patch is the smaller write.
    expect(patchBytes).toBeGreaterThan(0);
    expect(patchBytes).toBeLessThan(bodyBytes);
  });

  it("refuses to replay onto a record at another version (never a silent wrong body)", async () => {
    const store = new InMemoryCommitStore(createDemoModel());
    const sequencer = await Sequencer.start(store);
    const { before, cs } = await commit(sequencer, store, { type: "slide_branch", tapId: "tap-1", s: 3048 });
    const patch = changesetPatch(cs, (id) => before.elements[id]);
    const after = await store.head();
    expect(() => replayChangesetPatch(patch, (id) => after.elements[id])).toThrow(/patch is from version|undo record is version/);
    expect(() => replayChangesetPatch(patch, () => undefined)).toThrow(/missing/);
  });
});

describe("record differences", () => {
  it("sets, nests, removes keys and replaces arrays whole", () => {
    const a = { id: "x", version: 1, n: 1, nested: { keep: true, drop: 1, deep: { v: 1 } }, list: [1, 2, 3], gone: "y" };
    const b = { id: "x", version: 2, n: 1, nested: { keep: true, deep: { v: 2 }, added: null }, list: [1, 2] };
    expect(diffRecord(a, b)).toEqual([
      { p: ["gone"], d: true },
      { p: ["version"], v: 2 },
      { p: ["nested", "drop"], d: true },
      { p: ["nested", "deep", "v"], v: 2 },
      { p: ["nested", "added"], v: null },
      { p: ["list"], v: [1, 2] },
    ]);
    expect(diffRecord(a, a)).toEqual([]);
  });
});
