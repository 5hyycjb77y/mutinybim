/**
 * @jest-environment node
 *
 * Round 11 L11: lineages on the wire, beside older peers.
 * - A client never sends a lineage message the server didn't advertise; it
 *   answers itself in the "older server" words.
 * - An older peer sees copies as branches; a copy of a copy has no branch
 *   form and isn't listed to it.
 * - A copy's history reads its parent chain at any depth (branchHistory is
 *   the two-link case and answers as before).
 * - A branch session asked for a branch makes a copy of itself; a registry
 *   that can't record a parent refuses in words (never "Branches start from
 *   Main").
 * Fails on round 10's code: no lineage messages, and the service refuses
 * with START_BRANCH_FROM_MAIN.
 */
import { asElementId, asRevision, stateAt, type BimElement, type BranchRef, type Changeset, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { type Lineage } from "@permitzip/bim-kernel/lineages";
import { branchHistory, storeHistory, type HistoryReader, type HistorySource } from "../src/branches/history";
import { InMemoryBranchRegistry, type BranchRegistry } from "../src/branches/registry";
import { BranchService } from "../src/branches/service";
import { lineageHistory } from "../src/lineages/history";
import { LINEAGES_ACCEPT_BACK_FEATURE, LINEAGES_REVIEW_FEATURE, LINEAGES_ROLES_FEATURE, lineageRequestRefusal, lineagesForPeer, type LineageClientMessage } from "../src/lineages/protocol";
import { COPY_OF_COPY_UNAVAILABLE, type ChildLineageInput } from "../src/lineages/registry";
import { clientProtocol, serverProtocol } from "../src/protocol-version";

const AVERY = { provider: "unsigned", subject: "u-avery", kind: "person" } as const;
const nameOf = (el: BimElement | undefined): unknown => (el ? Reflect.get(el, "name") : undefined);
const lineage = (id: string, parent: Lineage["parent"], role = "proposal"): Lineage => ({ id, parent, role, returnPolicy: "merge", state: "open", name: id, createdBy: AVERY, createdAt: "2026-11-02T00:00:00Z" });

describe("l11-mixed-version", () => {
  it("answers a lineage request itself when the server is older, per feature", () => {
    const review: LineageClientMessage = { type: "lineage_review", requestId: "r1", lineageId: "shop", outcome: "approved", deltaDigest: "a".repeat(64) };
    const accept: LineageClientMessage = { type: "lineage_accept_back", requestId: "r2", from: "shop", recordIds: ["L2"], deltaDigest: "a".repeat(64) };
    const list: LineageClientMessage = { type: "lineage_list", requestId: "r3" };
    const older = serverProtocol();
    expect(lineageRequestRefusal(older, review)).toEqual({ type: "request_refused", requestId: "r1", reason: "Reviewing a copy isn't available on this model server yet: it is an older release. Ask your administrator to update the server." });
    expect(lineageRequestRefusal(older, accept)?.reason).toMatch(/^Accepting parts of a copy back isn't available/);
    expect(lineageRequestRefusal(older, list)?.reason).toMatch(/Branches still work/);
    const newer = serverProtocol([LINEAGES_ROLES_FEATURE, LINEAGES_REVIEW_FEATURE, LINEAGES_ACCEPT_BACK_FEATURE]);
    expect([review, accept, list].map((m) => lineageRequestRefusal(newer, m))).toEqual([null, null, null]);
    // Unadvertised by default until a writer lands.
    expect(serverProtocol().features).not.toContain(LINEAGES_ROLES_FEATURE);
  });

  it("shows an older peer copies of the first lineage as branches and hides copies of copies", () => {
    const all = [lineage("main", null, "design_record"), lineage("shop", { lineageId: "main", revision: 4 }, "shop"), lineage("prop", { lineageId: "shop", revision: 6 })];
    expect(lineagesForPeer(clientProtocol([LINEAGES_ROLES_FEATURE]), "m-1", all)).toEqual({ lineages: all });
    const older = lineagesForPeer(clientProtocol(), "m-1", all);
    expect(older).toEqual({ branches: [{ branchId: "shop", modelId: "m-1~shop", baseModelId: "m-1", baseRevision: 4, name: "shop", createdBy: "u-avery", createdAt: "2026-11-02T00:00:00Z", state: "open" }] });
  });

  describe("history over the chain", () => {
    const demo = createDemoModel("l11-sync");
    const lvl = (id: string, name: string): BimElement => ({ id: asElementId(id), version: 1, authoredRev: {}, kind: "level", name, elevationMm: 0 }) as BimElement;
    function store(start: ModelState, writes: readonly (readonly [string, string])[]): HistorySource & { readonly changes: Changeset[] } {
      let head = start;
      const changes: Changeset[] = [];
      for (const [id, name] of writes) {
        const rev = head.revision + 1;
        const el = { ...lvl(id, name), version: rev };
        changes.push({ revision: asRevision(rev), baseRevision: head.revision, idempotencyKey: `k${rev}`, actor: { id: "u", name: "U", kind: "human" }, command: { type: "set_tag_text", tagId: "t", text: "t" }, elements: [el], readSet: {}, authored: [], intents: [], rebased: false, committedAt: "2026-11-02T00:00:00Z", before: { [id]: head.elements[id] ?? null } });
        head = { ...head, revision: asRevision(rev), elements: { ...head.elements, [id]: el } };
      }
      const final = head;
      return { changes, head: async () => final, changesSince: async (r) => changes.filter((c) => c.revision > r) };
    }
    const root = { ...demo, revision: asRevision(0), elements: { L1: lvl("L1", "one") }, connections: [] };
    const design = store(root, [["L1", "design-1"], ["L1", "design-2"], ["L1", "design-3"]]); // r1..r3
    // shop forked at design@1, own r2..r3; prop forked at shop@2, own r3..r4
    const shopStart = { ...root, revision: asRevision(1), elements: { L1: { ...lvl("L1", "design-1"), version: 1 } } };
    const shop = store(shopStart, [["L2", "shop-2"], ["L1", "shop-3"]]);
    const propStart = { ...shopStart, revision: asRevision(2), elements: { ...shopStart.elements, L2: { ...lvl("L2", "shop-2"), version: 2 } } };
    const prop = store(propStart, [["L3", "prop-3"], ["L2", "prop-4"]]);
    const chain = [{ lineage: lineage("prop", { lineageId: "shop", revision: 2 }) }, { lineage: lineage("shop", { lineageId: "design", revision: 1 }) }, { lineage: lineage("design", null) }];
    const readers = new Map<string, HistoryReader>([
      ["design", storeHistory(design)],
      ["shop", storeHistory(shop)],
      ["prop", storeHistory(prop)],
    ]);
    const history = lineageHistory(chain, (id) => readers.get(id));

    it("reads each revision from the lineage that owns it, three deep", async () => {
      expect((await history.changesBetween(0, 4)).map((c) => [c.revision, nameOf(c.elements[0])])).toEqual([
        [1, "design-1"],
        [2, "shop-2"],
        [3, "prop-3"],
        [4, "prop-4"],
      ]);
      expect(await history.elementsAt(1, ["L1", "L2"])).toMatchObject({ L1: { name: "design-1" }, L2: null });
      expect(await history.elementsAt(2, ["L2"])).toMatchObject({ L2: { name: "shop-2" } });
      expect(await history.elementsAt(4, ["L2", "L3"])).toMatchObject({ L2: { name: "prop-4" }, L3: { name: "prop-3" } });
      // The same answer the kernel gives over the gathered line.
      const head = await prop.head();
      expect(stateAt(head, 1, await history.changesBetween(1, 4), [asElementId("L1"), asElementId("L2")])).toMatchObject({ L1: { name: "design-1" }, L2: null });
    });

    it("branchHistory is the two-link case and answers as before", async () => {
      const b = branchHistory({ baseRevision: 1 }, shop, storeHistory(design));
      expect((await b.changesBetween(0, 3)).map((c) => [c.revision, nameOf(c.elements[0])])).toEqual([
        [1, "design-1"],
        [2, "shop-2"],
        [3, "shop-3"],
      ]);
      expect(await b.elementsAt(1, ["L1"])).toMatchObject({ L1: { name: "design-1" } });
      expect(await b.elementsAt(3, ["L1"])).toMatchObject({ L1: { name: "shop-3" } });
      expect(await b.headRevision()).toBe(3);
    });
  });

  describe("a branch on a branch session", () => {
    const history: HistoryReader = { headRevision: async () => 5, elementsAt: async () => ({}), changesBetween: async () => [] };
    const onBranch: BranchRef = { branchId: "shop", modelId: "m-1~shop", baseModelId: "m-1", baseRevision: 2, name: "Shop", createdBy: "u-avery", createdAt: "2026-11-02T00:00:00Z", state: "open" };
    const create = { type: "branch_create", requestId: "c1", name: "Sub's proposal" } as const;

    it("refuses in words when the registry can't record a parent copy yet", async () => {
      // A registry from before copies of copies (W11's registries record a parent; this one doesn't).
      const inner = new InMemoryBranchRegistry();
      const older: BranchRegistry = { list: (b) => inner.list(b), get: (id) => inner.get(id), create: (i) => inner.create(i), close: (id) => inner.close(id), versions: (m) => inner.versions(m), saveVersion: (i) => inner.saveVersion(i), deleteVersion: (m, v) => inner.deleteVersion(m, v) };
      const service = new BranchService({ modelId: onBranch.modelId, registry: older, history, branch: onBranch });
      expect(await service.handle(create, { actorId: "u-avery", canWrite: true })).toEqual({ type: "request_refused", requestId: "c1", reason: COPY_OF_COPY_UNAVAILABLE });
    });

    it("makes a copy of the session's copy through a registry that records the parent", async () => {
      const made: ChildLineageInput[] = [];
      class ChildRegistry extends InMemoryBranchRegistry {
        async createChild(input: ChildLineageInput): Promise<BranchRef> {
          made.push(input);
          return { ...onBranch, branchId: "prop", modelId: "m-1~prop", name: input.name, baseRevision: input.baseRevision };
        }
      }
      const service = new BranchService({ modelId: onBranch.modelId, registry: new ChildRegistry(), history, branch: onBranch });
      const answer = await service.handle(create, { actorId: "u-avery", canWrite: true });
      expect(answer).toMatchObject({ type: "branch_saved", branch: { branchId: "prop", baseRevision: 5 } });
      expect(made).toEqual([{ parent: onBranch, name: "Sub's proposal", baseRevision: 5, createdBy: "u-avery" }]);
    });
  });
});
