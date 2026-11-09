/**
 * @jest-environment node
 *
 * i9-import-on-branch and i9-import-is-server-only: opening a linked model
 * as a proposal makes a new branch from Main's head and lands the converted
 * records on it in chunks (server-only `import_elements` revisions, the
 * person's name on each); Main never changes; Cancel closes the half-made
 * branch; a client can't send `import_elements`; and the person who opened
 * the proposal may edit it with only read access to Main, nobody else.
 *
 * Fails on round 8b's code: there was no import command, no server path to
 * land one and no proposal owner.
 */
import { IMPORT_SERVER_ONLY_REFUSAL, executeCommand, type Actor, type ModelState } from "@permitzip/bim-kernel";
import { InMemoryBranchHost } from "@permitzip/bim-sync";
import { readIfcSource } from "@permitzip/bim-ifc";
import { architectureAndStructure, hostModel } from "../../../../packages/bim-ifc/__tests__/i9-fixtures";
import { ImportService, InMemoryImportRuns, landImportOnBranch, proposalOwnerCanWrite, type ImportLandDeps, type RunningConvert } from "../import";

const rao: Actor = { id: "user-rao", name: "J. Rao", kind: "human" };

function main(): ModelState {
  return { ...hostModel(), modelId: "site-1" };
}

function source() {
  return readIfcSource(architectureAndStructure().text, { sourceId: "ver-arch-1", label: "Main St shell", disciplines: ["architecture", "structure"] });
}

function depsFor(host: InMemoryBranchHost): ImportLandDeps {
  return {
    createBranch: (input) => host.registry.create({ baseModelId: "site-1", ...input }),
    closeBranch: async (id) => void (await host.registry.close(id, "test")),
    openBranch: async (id) => {
      const served = await host.open(id);
      if (!served) throw new Error(`branch ${id} not served`);
      return served.sequencer;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

describe("i9-import-on-branch", () => {
  it("lands every converted record on a new branch in chunks, as the person; Main is unchanged", async () => {
    const host = await InMemoryBranchHost.start(main());
    const before = await host.main.store.head();
    const result = await landImportOnBranch(depsFor(host), { main: before, source: source(), referenceId: "ref-arch", sourceKey: "v1", branchName: "Proposal: Main St shell", actor: rao, chunkSize: 3 });
    if (result.status !== "done") throw new Error(`expected done, got ${result.status}`);
    // Round 14 A14: the roof and the stair import as records too (two more), so 10 land in 4 chunks of 3.
    expect(result.revisions).toBe(4);
    expect(result.landed).toBe(10);
    const branch = await host.open(result.branch.modelId);
    const head = await branch?.store.head();
    const imported = Object.values(head?.elements ?? {}).filter((e) => e.id.startsWith("imp."));
    expect(imported.map((e) => e.kind).sort()).toEqual(["architecture.roof", "architecture.stair", "beam", "column", "level", "opening", "room", "slab", "wall", "wall"]);
    const changes = await branch?.store.changesSince(result.branch.baseRevision);
    expect(changes?.map((c) => [c.command.type, c.actor.name])).toEqual([["import_elements", "J. Rao"], ["import_elements", "J. Rao"], ["import_elements", "J. Rao"], ["import_elements", "J. Rao"]]);
    // Main: same revision, none of the imported records.
    const after = await host.main.store.head();
    expect(after.revision).toBe(before.revision);
    expect(Object.keys(after.elements).some((id) => id.startsWith("imp."))).toBe(false);
    expect(result.branch).toMatchObject({ baseModelId: "site-1", name: "Proposal: Main St shell", createdBy: rao.id, state: "open" });
  });

  it("Cancel between chunks closes the half-made branch and leaves Main alone", async () => {
    const host = await InMemoryBranchHost.start(main());
    const before = await host.main.store.head();
    let progressed = 0;
    const result = await landImportOnBranch(depsFor(host), {
      main: before,
      source: source(),
      referenceId: "ref-arch",
      sourceKey: "v1",
      branchName: "Stopped",
      actor: rao,
      chunkSize: 2,
      onProgress: () => void (progressed += 1),
      isCancelled: () => progressed >= 2,
    });
    expect(result.status).toBe("cancelled");
    const branches = await host.registry.list("site-1");
    expect(branches.map((b) => b.state)).toEqual(["closed"]);
    expect((await host.main.store.head()).revision).toBe(before.revision);
  });
});

describe("i9-import-is-server-only", () => {
  it("the hub refuses a client's import_elements in plain words, and the kernel refuses it without the server's records", async () => {
    const host = await InMemoryBranchHost.start(main());
    const before = await host.main.store.head();
    const heard: string[] = [];
    const raw = { id: "raw-rao", send: (data: string) => heard.push(data) };
    host.main.hub.join(raw, { actorId: rao.id, canWrite: true });
    const forged = { type: "import_elements", sourceId: "ver-x", label: "Forged", chunk: 1, of: 1 };
    await host.main.hub.handle(raw, JSON.stringify({ type: "command", request: { idempotencyKey: "forged-import-1", baseRevision: before.revision, actor: rao, command: forged } }));
    await settle();
    const answers = heard.map((h): unknown => JSON.parse(h));
    expect(answers).toContainEqual({ type: "outcome", idempotencyKey: "forged-import-1", outcome: { status: "rejected", error: expect.objectContaining({ code: "forbidden", message: IMPORT_SERVER_ONLY_REFUSAL }) } });
    expect((await host.main.store.head()).revision).toBe(before.revision);
    const direct = executeCommand(before, { type: "import_elements", sourceId: "ver-x", label: "Forged", chunk: 1, of: 1 });
    expect(direct).toEqual({ ok: false, error: { code: "forbidden", message: IMPORT_SERVER_ONLY_REFUSAL, elementIds: [] } });
  });
});

describe("i9 proposal owner (product decision answer 7)", () => {
  it("the person who opened a proposal may edit it with read access to Main; another reader may not; Main never", async () => {
    const runs = new InMemoryImportRuns();
    await runs.create({ id: "11111111-1111-4111-8111-111111111111", baseModelId: "site-1", createdBy: rao.id, referenceId: "ref", sourceVersionId: "ver", sourceSha256: "a".repeat(64), hostJobId: null, status: "converting" });
    await runs.update("11111111-1111-4111-8111-111111111111", { status: "done", branchModelId: "site-1~abc" });
    expect(await proposalOwnerCanWrite(runs, { modelId: "site-1~abc", userId: rao.id, canRead: true, canWrite: false })).toBe(true);
    expect(await proposalOwnerCanWrite(runs, { modelId: "site-1~abc", userId: "user-other", canRead: true, canWrite: false })).toBe(false);
    expect(await proposalOwnerCanWrite(runs, { modelId: "site-1~abc", userId: rao.id, canRead: false, canWrite: false })).toBe(false);
    expect(await proposalOwnerCanWrite(runs, { modelId: "site-1", userId: rao.id, canRead: true, canWrite: false })).toBe(false);
  });
});

describe("i9 import service", () => {
  it("runs a conversion to a branch, reports progress to its starter only, and Cancel during conversion makes no branch", async () => {
    const host = await InMemoryBranchHost.start(main());
    const runs = new InMemoryImportRuns();
    let release: (() => void) | null = null;
    const service = new ImportService({
      runs,
      verify: async (token) => ({ userId: token }),
      canRead: async () => true,
      servedModelId: (m) => m,
      mainHead: () => host.main.store.head(),
      landDeps: () => depsFor(host),
      convert: (): RunningConvert => {
        let cancel: (reason: Error) => void = () => undefined;
        const result = new Promise<ReturnType<typeof source>>((resolve, reject) => {
          cancel = reject;
          release = () => resolve(source());
        });
        return { result, cancel: () => cancel(new Error("stopped")) };
      },
      allowedSource: () => true,
    });
    const body = { name: "Proposal", personName: "J. Rao", referenceId: "ref-arch", versionId: "ver-arch-1", label: "Main St shell", disciplines: ["architecture"], sourceUrl: "https://example.invalid/storage/v1/object/sign/x", sha256: "b".repeat(64) };
    const runId = await service.start("site-1", { userId: rao.id }, body);
    expect((await service.progress(runId, { userId: rao.id }))?.status).toBe("converting");
    expect(await service.progress(runId, { userId: "user-other" })).toBeNull();
    const releaseNow: () => void = release ?? (() => undefined);
    releaseNow();
    for (let i = 0; i < 20 && (await service.progress(runId, { userId: rao.id }))?.status !== "done"; i++) await settle();
    const done = await service.progress(runId, { userId: rao.id });
    expect(done).toMatchObject({ status: "done", landed: 10, report: { converted: 9 } });
    expect(done?.branch?.modelId).toMatch(/^site-1~/);
    expect(runs.rows.get(runId)).toMatchObject({ status: "done", branchModelId: done?.branch?.modelId });

    expect(runs.rows.get(runId)?.hostJobId).toBeNull();

    // The host's own record of the import is kept with the run, under its current or its earlier wire name.
    const second = await service.start("site-1", { userId: rao.id }, { ...body, name: "Second", hoursJobId: "job-earlier-name" });
    expect(runs.rows.get(second)?.hostJobId).toBe("job-earlier-name");
    expect(service.cancel(second, { userId: "user-other" })).toBe(false);
    expect(service.cancel(second, { userId: rao.id })).toBe(true);
    for (let i = 0; i < 20 && (await service.progress(second, { userId: rao.id }))?.status === "converting"; i++) await settle();
    expect(await service.progress(second, { userId: rao.id })).toMatchObject({ status: "cancelled", branch: null, error: "Stopped. Nothing was converted and Main didn't change." });
    expect((await host.registry.list("site-1")).map((b) => b.name)).toEqual(["Proposal"]);
  });
});
