/**
 * @jest-environment node
 *
 * Round 11 L11 (product owner answer 2): on a contractor's copy the parent's
 * responsible professionals (the engineer of record) hold propose and review
 * by default and edit only when the copy's owner grants it. The rows are on
 * LINEAGE_ROLE_POINT; a firm's role is one row with zero kernel edits. Fails
 * on round 10's code: no roles, no capabilities.
 */
import { asElementId, type BimElement, type CoverageContext, type Responsibility } from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION } from "../src/packs";
import { lineageCapabilitiesFor, responsibleForCopy } from "../src/lineages/capabilities";
import { BUILT_IN_LINEAGE_ROLES, LINEAGE_ROLE_POINT, lineageRole, lineageRoleProblems, lineageRoles, type LineageRoleDef } from "../src/lineages/roles";

const shop = { role: "shop", state: "open" } as const;

describe("l11-eor-propose-default", () => {
  it("ships the nine first-party roles, each conformant", () => {
    expect(BUILT_IN_LINEAGE_ROLES.map((r) => r.id)).toEqual(["design_record", "option", "proposal", "coordination", "shop", "submittal", "external_author", "as_built", "operations"]);
    for (const r of BUILT_IN_LINEAGE_ROLES) expect(lineageRoleProblems(r)).toEqual([]);
    expect(lineageRole("proposal")?.defaultReturnPolicy).toBe("merge");
    expect(lineageRole("shop")?.defaultReturnPolicy).toBe("accept_back");
    expect(lineageRole("operations")?.defaultReturnPolicy).toBe("never");
  });

  it("gives the engineer of record propose and review on a contractor's copy, edit only when the owner raises it", () => {
    expect([...lineageCapabilitiesFor(shop, "parent_responsible")].sort()).toEqual(["propose", "read", "review"]);
    expect([...lineageCapabilitiesFor(shop, "parent_responsible", [{ capability: "edit" }])].sort()).toEqual(["edit", "propose", "read", "review"]);
    // The owner can't raise past what the role allows; an own-firm proposal has no raise to edit.
    expect(lineageCapabilitiesFor({ role: "proposal", state: "open" }, "parent_responsible", [{ capability: "edit" }])).not.toContain("edit");
  });

  it("lets the contractor's named people edit, parent readers read and copy only where the role allows, and anything closed is read only", () => {
    expect(lineageCapabilitiesFor(shop, "named_editor")).toContain("edit");
    expect(lineageCapabilitiesFor(shop, "parent_reader")).toEqual([]);
    expect([...lineageCapabilitiesFor({ role: "coordination", state: "open" }, "parent_reader")].sort()).toEqual(["propose", "read"]);
    expect(lineageCapabilitiesFor({ role: "shop", state: "closed" }, "creator")).toEqual(["read"]);
    expect(lineageCapabilitiesFor(shop, "someone_new")).toEqual([]);
    expect([...lineageCapabilitiesFor({ role: "acme.unknown", state: "open" }, "parent_responsible", [{ capability: "edit" }])].sort()).toEqual(["propose", "read"]);
  });

  it("finds the responsible professionals whose accepted scope covers what the copy changed", () => {
    const ctx: CoverageContext = { disciplineOf: (e) => e.partition?.discipline ?? "general", classOf: () => undefined, isA: (c, a) => c === a, systemsOf: () => [], groupsOf: () => [], sheetsOf: () => [], matches: () => true };
    const el = (id: string, discipline: string) => ({ id: asElementId(id), kind: "part", version: 1, authoredRev: {}, partition: { level: "L1", zone: "Z1", discipline }, typeId: "pt", values: {} }) as unknown as BimElement;
    const row = (id: string, discipline: string, accepted = true): Responsibility => ({ id, party: { kind: "person", ref: `u-${id}`, label: id }, discipline, ...(accepted ? { acceptedAt: "2026-11-01T00:00:00Z" } : {}) });
    const found = responsibleForCopy([el("p1", "discipline_a")], [row("ra", "discipline_a"), row("rb", "discipline_b"), row("rc", "discipline_a", false)], ctx);
    expect(found.map((r) => r.id)).toEqual(["ra"]);
  });

  it("takes a firm's own role as one row, with no kernel edit", () => {
    const tenant: LineageRoleDef = { id: "acme.tenant_fitout", label: "Tenant fit-out", description: "A tenant's designer works here; parts come back by review.", defaultReturnPolicy: "accept_back", read: "named_only", parentResponsible: { holds: ["read", "propose", "review"], ownerMayRaiseTo: ["edit"] } };
    const pack = definePack({ id: "acme", name: "Acme", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(LINEAGE_ROLE_POINT, [tenant])]);
    const set = PackSet.create([pack]);
    expect(lineageRoles(set).map((r) => r.id)).toContain("acme.tenant_fitout");
    expect(lineageCapabilitiesFor({ role: "acme.tenant_fitout", state: "open" }, "parent_responsible", [{ capability: "edit" }], set)).toContain("edit");
  });
});
