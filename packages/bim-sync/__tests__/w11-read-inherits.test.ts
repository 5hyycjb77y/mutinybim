/**
 * @jest-environment node
 *
 * Round 11 W11 (D1): everyone who reads a copy's parent reads it (and may copy
 * it) unless its purpose restricts that; reading never brings edit; a closed
 * copy is read only, even for its creator; nobody without the design's read
 * gets anything.
 *
 * Fails on round 10's code: a copy's readers and editors were its base's, so
 * the design's editor could edit every copy and a closed copy's rights were
 * never per copy.
 */
import { NO_MODEL_ACCESS } from "../src";
import { lineageRights, LINEAGE_RIGHTS_WORDS } from "../src/lineages";
import { admit, BASE, editTerminal, expectLineage, gc, avery, outsider, riley, sam, startCopies } from "./support/w11-copies";

describe("w11-read-inherits", () => {
  it("a coordination copy is read by the design's readers, edited by its own people only", async () => {
    const env = await startCopies();
    const gcOnDesign = await admit(env, gc, BASE);
    const coordination = expectLineage(await gcOnDesign.ask({ type: "lineage_create", name: "Coordination", role: "coordination" }), "lineage_saved").lineage;
    const id = `${BASE}~${coordination.id}`;

    for (const reader of [sam, riley, avery]) {
      const s = await admit(env, reader, id);
      expect(s.principal.canWrite).toBe(false);
      expect(expectLineage(await s.ask({ type: "lineage_list" }), "lineages").lineages.map((l) => l.id)).toContain(coordination.id);
    }
    // The design's editor reads the copy but doesn't edit it: edit is per copy.
    const averyOn = await admit(env, avery, id);
    expect(await editTerminal(averyOn, 999)).toEqual({ status: "rejected", message: LINEAGE_RIGHTS_WORDS.noEdit });

    // No design read, no copy.
    await expect(admit(env, outsider, id)).rejects.toThrow(NO_MODEL_ACCESS);

    // Closed: read only, even for its creator.
    const gcOn = await admit(env, gc, id);
    expect(gcOn.principal.canWrite).toBe(true);
    await env.host.registry.close(id);
    const gcAfter = await admit(env, gc, id);
    expect([...(gcAfter.principal.lineage?.rights.get(coordination.id) ?? [])]).toEqual(["read"]);
  });

  it("the rule needs a chain that ends at the first copy", () => {
    expect(() => lineageRights({ userId: "u", model: { read: true, edit: true }, chain: [], grants: [] })).toThrow();
  });
});
