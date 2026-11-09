/**
 * @jest-environment node
 *
 * `kindsWrittenSince`: which kinds an edit wrote, from the edit's own
 * pending writes, so a derived read cached per record (a pack's structural
 * supports for lint) can skip an edit that touched none of its kinds without
 * listing them. Null whenever the two records aren't a draft and its base.
 */
import { draftElements, freezeElements, kindsWrittenSince } from "../src/store";
import { asElementId, type Level } from "../src/types";

const level = (id: string, name: string, elevationMm: number): Level => ({ id: asElementId(id), version: 1, authoredRev: {}, kind: "level", name, elevationMm });

function committed() {
  return freezeElements({ "L-1": level("L-1", "Ground", 0), "L-2": level("L-2", "Roof", 4572) });
}

describe("kindsWrittenSince", () => {
  it("names the kinds a draft set, added and removed on its base, and nothing it didn't write", () => {
    const base = committed();
    const untouched = draftElements(base);
    expect([...(kindsWrittenSince(untouched, base) ?? ["unknown"])]).toEqual([]);

    const moved = draftElements(base);
    moved["L-2"] = level("L-2", "Roof", 4600);
    expect([...(kindsWrittenSince(moved, base) ?? [])]).toEqual(["level"]);

    const removed = draftElements(base);
    delete removed["L-1"];
    expect([...(kindsWrittenSince(removed, base) ?? [])]).toEqual(["level"]);

    const added = draftElements(base);
    added["L-3"] = level("L-3", "Penthouse", 9144);
    expect([...(kindsWrittenSince(added, base) ?? [])]).toEqual(["level"]);
  });

  it("follows a chain of edits: each draft against the record it was made on", () => {
    const base = committed();
    const first = draftElements(base);
    first["L-2"] = level("L-2", "Roof", 4600);
    const second = draftElements(first);
    expect([...(kindsWrittenSince(second, first) ?? ["unknown"])]).toEqual([]);
  });

  it("is null when the records aren't a draft and its base, so the caller compares them itself", () => {
    const base = committed();
    const other = committed();
    const edited = draftElements(base);
    edited["L-2"] = level("L-2", "Roof", 4600);
    expect(kindsWrittenSince(edited, other)).toBeNull();
    expect(kindsWrittenSince(base, edited)).toBeNull();
    expect(kindsWrittenSince({ ...base }, base)).toBeNull();
    const second = draftElements(edited);
    expect(kindsWrittenSince(second, base)).toBeNull();
  });
});
