/**
 * @jest-environment node
 *
 * Round 7 lane C: mixed versions. Every peer of this release advertises
 * `elements:ceilings` (it joins `gatedRecordFeatures()`), so a writer stores
 * ceilings only when its peers read them, and says so in plain words when
 * they don't. A peer that doesn't write ceilings still keeps every ceiling
 * record it receives, byte for byte, including a newer peer's form and role
 * it doesn't know; the readers answer from them as ceilings.
 *
 * Fails on the old code: the feature wasn't advertised, the commands didn't
 * exist, and the readers didn't exist.
 */
import { asElementId, CEILINGS_FEATURE, CEILINGS_NOT_YET, ceilingForm, ceilingHeightAt, ceilingRole, gatedRecordFeatures, surfacesAt, type BimElement, type Ceiling, type ModelState } from "../src";
import { commit, FT, officeModel, OFFICE, tryCommit, type Policy } from "./c7c-fixtures";

const OLDER_SERVER: Policy = (feature) => feature !== CEILINGS_FEATURE;
const L1 = asElementId("lvl-1");

/** A ceiling a newer peer wrote: a form and a role this release doesn't know, a field it has never heard of. */
function newerPeersCeiling(): BimElement {
  const record = {
    id: asElementId("vault-1"),
    kind: "ceiling",
    version: 3,
    authoredRev: {},
    partition: { level: "Level 1", zone: "Z1", discipline: "architecture" },
    classId: "arch.ceiling",
    schemaVersion: 2,
    levelId: L1,
    outline: OFFICE,
    form: "barrel_vault",
    heightMm: 11 * FT,
    role: "zz.coffer",
    futureField: { kept: true },
  };
  return record as unknown as BimElement;
}

describe("c7c mixed versions", () => {
  it("every peer of this release advertises elements:ceilings", () => {
    expect(gatedRecordFeatures()).toContain("elements:ceilings");
  });

  it("a writer whose server doesn't advertise it refuses with a plain reason, and nothing changes", () => {
    const m = officeModel();
    const create = tryCommit(m, { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT }] }, OLDER_SERVER);
    expect(create.ok ? "" : create.message).toBe(CEILINGS_NOT_YET);
    expect(tryCommit(m, { type: "make_ceiling_from_space_height", spaceId: "s101" }, OLDER_SERVER)).toEqual({ ok: false, message: CEILINGS_NOT_YET });
    const withOne = commit(m, { type: "create_ceiling", ceilings: [{ ceilingId: "c1", levelId: "lvl-1", outline: OFFICE, heightMm: 9 * FT }] });
    expect(tryCommit(withOne, { type: "edit_ceiling", ceilingId: "c1", heightMm: 8 * FT }, OLDER_SERVER)).toEqual({ ok: false, message: CEILINGS_NOT_YET });
    expect(tryCommit(withOne, { type: "delete_ceilings", ceilingIds: ["c1"] }, OLDER_SERVER)).toEqual({ ok: false, message: CEILINGS_NOT_YET });
  });

  it("a peer that doesn't write ceilings keeps the ceiling records it receives, untouched by its own edits", () => {
    const m0 = officeModel();
    const received = newerPeersCeiling();
    const m: ModelState = { ...m0, elements: { ...m0.elements, [received.id]: received } };
    const after = commit(m, { type: "edit_space", spaceId: "s101", name: "Open office" }, OLDER_SERVER);
    expect(after.elements["vault-1"]).toBe(received);
    const later = commit(after, { type: "create_level", levelId: "lvl-3", name: "Level 3", elevationMm: 26 * FT }, () => false);
    expect(later.elements["vault-1"]).toEqual(received);
  });

  it("readers keep a newer peer's form and role and read the record as a ceiling", () => {
    const m0 = officeModel();
    const received = newerPeersCeiling();
    const m: ModelState = { ...m0, elements: { ...m0.elements, [received.id]: received } };
    const c = m.elements["vault-1"] as Ceiling;
    expect(ceilingForm(c)).toBe("barrel_vault");
    expect(ceilingRole(c)).toEqual({ id: "zz.coffer", label: "Coffer", hostsDevices: true });
    expect(ceilingHeightAt(m.elements, L1, { x: 5 * FT, y: 5 * FT })).toEqual({ heightMm: 11 * FT, ceilingId: "vault-1", form: "barrel_vault", role: "zz.coffer", slope: null });
    const r = surfacesAt(m, { point: { x: 5 * FT, y: 5 * FT }, levelId: L1 });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ceiling?.source).toEqual({ kind: "ceiling", id: "vault-1", name: "Coffer vault-1", form: "barrel_vault", surfaceRole: "zz.coffer" });
  });
});
