/**
 * @jest-environment node
 *
 * Round 8b coordinator: a merge, end to end in one process. A person starts
 * a branch, two disciplines change on it, the person proposes, one covering
 * professional approves, and `merge_apply` over the branch session lands
 * only the approved part on Main, through Main's own sequencer, as one
 * `merge_branch_part` revision attributed to the person. An approval that
 * names an older digest counts for nothing; a fresh one lands the rest.
 * Main changes only by the approved parts, a client can't send the
 * server-only command, and an agent can't apply.
 *
 * Fails on round 8 / the lanes' code alone: the hub had no merge handler
 * (merge messages weren't even client messages), the client couldn't ask,
 * and no command could land a part on Main.
 */
import { canonicalJson, partitionOf, type BimElement, type MergeApprovalRecord, type ModelState, type Responsibility } from "@permitzip/bim-kernel";
import { agentActor, InMemoryBranchHost, MERGE_NEEDS_PERSON, PROTOCOL_FEATURES, type ApprovalSnapshot, type MergeApprovalSource, type MergeServerMessage, type ProposalSnapshot } from "../src";
import { attach, expectAnswer, jordan, avery, settle } from "./support/b8-branch-host";
import { airflowOf } from "@permitzip/bim-pack-mechanical";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const ACCEPTED = "2026-11-01T05:00:00Z";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const rao: Responsibility = { id: "11111111-1111-4111-8111-111111111111", party: { kind: "person", ref: "user-rao", label: "J. Rao" }, discipline: "mechanical", acceptedAt: ACCEPTED };
const example: Responsibility = { id: "22222222-2222-4222-8222-222222222222", party: { kind: "person", ref: "user-example", label: "K. Example" }, discipline: "plumbing", acceptedAt: ACCEPTED };
/** Model-wide records (groups, levels) sit in the architecture discipline. */
const doe: Responsibility = { id: "44444444-4444-4444-8444-444444444444", party: { kind: "person", ref: "user-doe", label: "R. Doe" }, discipline: "architecture", acceptedAt: ACCEPTED };

/** The demo model with its second supply terminal filed under plumbing: the mechanical ducts' airflow hangs on it. */
function twoDisciplines(): ModelState {
  const demo = createDemoModel("site-1");
  const sd2 = demo.elements["sd-2"];
  if (!sd2) throw new Error("demo model has no sd-2");
  const moved: BimElement = { ...sd2, partition: { ...partitionOf(sd2), discipline: "plumbing" } };
  return { ...demo, elements: { ...demo.elements, "sd-2": moved } };
}

/** The host's records as the merge reads them: who is responsible, the proposal, and its approvals so far. */
function hostRecords() {
  const approvals: MergeApprovalRecord[] = [];
  const base = (): ApprovalSnapshot => ({ responsibilities: [rao, example, doe], approvals: [...approvals], leads: [], rules: {} });
  const source: MergeApprovalSource = {
    responsibilitiesFor: async () => base(),
    proposalFor: async ({ proposalId }): Promise<ProposalSnapshot | null> =>
      proposalId === PROPOSAL ? { ...base(), proposal: { id: PROPOSAL, baseModelId: "site-1", branchId: branchIdRef.value, status: "open", proposedBy: avery.id } } : null,
  };
  const approve = (r: Responsibility, digest: string, seen: number) =>
    approvals.push({ responsibilityId: r.id, approverRef: r.party.ref, approverLabel: r.party.label, decision: "approved", seenBranchHead: seen, decidedAt: "2026-11-01T06:00:00Z", deltaDigest: digest });
  return { source, approve };
}

const branchIdRef = { value: "" };

function result<T extends MergeServerMessage["type"]>(msg: MergeServerMessage, type: T): Extract<MergeServerMessage, { type: T }> {
  if (msg.type !== type) throw new Error(`expected ${type}, got ${msg.type}${msg.type === "merge_refused" ? `: ${msg.message}` : ""}`);
  return msg as Extract<MergeServerMessage, { type: T }>;
}

describe("m8b-merge-end-to-end", () => {
  it("lands only the approved part on Main, refuses a stale digest, then lands the rest", async () => {
    const records = hostRecords();
    const host = await InMemoryBranchHost.start(twoDisciplines(), {}, records.source);
    const onMain = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const mainBefore = await host.main.store.head();

    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "Supply option B" }), "branch_saved");
    branchIdRef.value = created.branch.branchId;
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const person = attach(served.hub, avery, "branch-avery", { modelId: created.branch.modelId });
    await settle();
    expect(person.client.mergeAvailable()).toBe(true);
    expect(onMain.client.mergeAvailable()).toBe(false);

    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 });
    await settle();
    person.client.submit({ type: "create_group", groupId: "grp-lobby", name: "Lobby option B" });
    await settle();
    expect(person.outcomes.map((o) => o.status)).toEqual(["committed", "committed"]);

    const preview = result(await person.client.mergeRequest({ type: "merge_preview" }), "merge_preview_result").preview;
    const byDiscipline = Object.fromEntries(preview.parts.map((p) => [p.discipline, p]));
    // A terminal's airflow re-derives the ducts upstream of it: mechanical carries sd-1 and its runs; architecture only the new group.
    const mechanicalIds = new Set<string>(byDiscipline.mechanical?.elementIds ?? []);
    expect(mechanicalIds.has("sd-1")).toBe(true);
    expect(byDiscipline.architecture?.elementIds).toEqual(["grp-lobby"]);
    const staleDigest = byDiscipline.mechanical?.deltaDigest ?? "";
    records.approve(rao, staleDigest, preview.branchHead);
    records.approve(doe, byDiscipline.architecture?.deltaDigest ?? "", preview.branchHead);

    // sd-1 changes again after Rao approved: his approval names the old digest and no longer counts.
    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 430 });
    await settle();
    const first = result(await person.client.mergeRequest({ type: "merge_apply", proposalId: PROPOSAL }), "merge_apply_result");
    expect(first.landed.map((l) => l.discipline)).toEqual(["architecture"]);
    expect(first.waiting.map((w) => w.discipline)).toEqual(["mechanical"]);
    expect(first.allLanded).toBe(false);
    const afterFirst = await host.main.store.head();
    expect(afterFirst.revision).toBe(mainBefore.revision + 1);
    const landed = (await host.main.store.changesSince(mainBefore.revision))[0];
    expect(landed?.command).toMatchObject({ type: "merge_branch_part", discipline: "architecture", branchModelId: created.branch.modelId });
    expect(landed?.actor.id).toBe(avery.id);
    // Main changed by the approved part only.
    expect(landed?.elements.map((e) => e.id)).toEqual(["grp-lobby"]);
    expect(afterFirst.elements["grp-lobby"]?.kind).toBe("organization");
    const { version: _mainVersion, ...onMainGroup } = afterFirst.elements["grp-lobby"] ?? { version: 0 };
    const { version: _branchVersion, ...onBranchGroup } = (await served.store.head()).elements["grp-lobby"] ?? { version: 0 };
    expect(canonicalJson(onMainGroup)).toBe(canonicalJson(onBranchGroup));
    for (const id of mechanicalIds) expect(canonicalJson(afterFirst.elements[id])).toBe(canonicalJson(mainBefore.elements[id]));

    // A fresh approval of what the branch holds now lands mechanical, and the branch is merged.
    const again = result(await person.client.mergeRequest({ type: "merge_preview" }), "merge_preview_result").preview;
    const mechanical = again.parts.find((p) => p.discipline === "mechanical");
    expect(mechanical?.deltaDigest).not.toBe(staleDigest);
    records.approve(rao, mechanical?.deltaDigest ?? "", again.branchHead);
    const rest = result(await person.client.mergeRequest({ type: "merge_apply", proposalId: PROPOSAL }), "merge_apply_result");
    expect(rest.landed.map((l) => l.discipline)).toEqual(["mechanical"]);
    expect(rest.allLanded).toBe(true);
    const mainAfter = await host.main.store.head();
    expect(airflowOf(mainAfter.elements["sd-1"] as BimElement)).toBe(430);
    expect(mainAfter.revision).toBe(mainBefore.revision + 2);
    expect(host.registry.stateOf(created.branch.modelId)).toBe("merged");
    const mergedIds = new Set<string>([...(mechanical?.elementIds ?? []), "grp-lobby"]);
    for (const id of Object.keys(mainBefore.elements)) {
      if (mergedIds.has(id)) continue;
      expect(canonicalJson(mainAfter.elements[id])).toBe(canonicalJson(mainBefore.elements[id]));
    }
  });

  it("an approved part that hangs on a waiting part doesn't land alone", async () => {
    const records = hostRecords();
    const host = await InMemoryBranchHost.start(twoDisciplines(), {}, records.source);
    const onMain = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const mainBefore = await host.main.store.head();
    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "Shared trunk" }), "branch_saved");
    branchIdRef.value = created.branch.branchId;
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const person = attach(served.hub, avery, "branch-avery", { modelId: created.branch.modelId });
    await settle();
    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 });
    await settle();
    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-2", cfm: 380 });
    await settle();
    const preview = result(await person.client.mergeRequest({ type: "merge_preview" }), "merge_preview_result").preview;
    const mechanical = preview.parts.find((p) => p.discipline === "mechanical");
    records.approve(rao, mechanical?.deltaDigest ?? "", preview.branchHead);
    const held = result(await person.client.mergeRequest({ type: "merge_apply", proposalId: PROPOSAL }), "merge_apply_result");
    expect(held.landed).toEqual([]);
    expect(held.waiting.find((w) => w.discipline === "mechanical")?.words).toMatch(/can't land alone: .* depends on SD-2 in Plumbing, which is still waiting/);
    expect((await host.main.store.head()).revision).toBe(mainBefore.revision);
  });

  it("refuses a stale Main: someone changed what the part writes since the merge read Main", async () => {
    const records = hostRecords();
    const host = await InMemoryBranchHost.start(twoDisciplines(), {}, records.source);
    const onMain = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    const other = attach(host.main.hub, jordan, "main-jordan", { modelId: "site-1" });
    await settle();
    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "Race" }), "branch_saved");
    branchIdRef.value = created.branch.branchId;
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const person = attach(served.hub, avery, "branch-avery", { modelId: created.branch.modelId });
    await settle();
    person.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 });
    await settle();
    const preview = result(await person.client.mergeRequest({ type: "merge_preview" }), "merge_preview_result").preview;
    records.approve(rao, preview.parts[0]?.deltaDigest ?? "", preview.branchHead);
    // Jordan changes sd-1 on Main after the branch started: a three-way conflict, so nothing lands.
    other.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 500 });
    await settle();
    const applied = result(await person.client.mergeRequest({ type: "merge_apply", proposalId: PROPOSAL }), "merge_apply_result");
    expect(applied.landed).toEqual([]);
    expect(airflowOf((await host.main.store.head()).elements["sd-1"] as BimElement)).toBe(500);
  });

  it("a client can't send the server-only command, and an agent can't apply a merge", async () => {
    const records = hostRecords();
    const host = await InMemoryBranchHost.start(twoDisciplines(), {}, records.source);
    const onMain = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const before = await host.main.store.head();
    // Straight onto the wire, past any client-side prediction: the hub refuses it before the sequencer.
    const heard: string[] = [];
    const raw = { id: "raw-avery", send: (data: string) => heard.push(data) };
    host.main.hub.join(raw, { actorId: avery.id, canWrite: true });
    const forged = { type: "merge_branch_part" as const, branchModelId: "site-1~x", discipline: "mechanical", label: "Forged" };
    await host.main.hub.handle(raw, JSON.stringify({ type: "command", request: { idempotencyKey: "forged-merge-1", baseRevision: before.revision, actor: avery, command: forged } }));
    const answers = heard.map((h): unknown => JSON.parse(h));
    expect(answers).toContainEqual({ type: "outcome", idempotencyKey: "forged-merge-1", outcome: { status: "rejected", error: expect.objectContaining({ code: "forbidden", message: expect.stringContaining("Merge approved parts") }) } });
    // And through the client: its own prediction refuses it in the same words, and nothing is sent.
    const local = onMain.client.submit(forged);
    expect(local).toEqual({ ok: false, error: expect.objectContaining({ code: "forbidden", message: expect.stringContaining("Merge approved parts") }) });
    await settle();
    expect(onMain.outcomes).toEqual([]);
    expect((await host.main.store.head()).revision).toBe(before.revision);

    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "Agent's" }), "branch_saved");
    branchIdRef.value = created.branch.branchId;
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const agent = attach(served.hub, agentActor(avery.id, "run-1", "Host agent"), "branch-agent", { modelId: created.branch.modelId });
    await settle();
    agent.client.submit({ type: "set_terminal_cfm", terminalId: "sd-1", cfm: 420 });
    await settle();
    expect(result(await agent.client.mergeRequest({ type: "merge_preview" }), "merge_preview_result").preview.parts.length).toBeGreaterThan(0);
    const refused = result(await agent.client.mergeRequest({ type: "merge_apply", proposalId: PROPOSAL }), "merge_refused");
    expect(refused.message).toBe(MERGE_NEEDS_PERSON);
    expect((await host.main.store.head()).revision).toBe(before.revision);
  });

  it("advertises branches:merge only where a hub serves merges", async () => {
    expect(PROTOCOL_FEATURES.branchesMerge).toBe("branches:merge");
    const host = await InMemoryBranchHost.start(createDemoModel("site-1"));
    const onMain = attach(host.main.hub, avery, "main-avery", { modelId: "site-1" });
    await settle();
    const created = expectAnswer(await onMain.client.request({ type: "branch_create", name: "No merges" }), "branch_saved");
    const served = await host.open(created.branch.modelId);
    if (!served) throw new Error("branch not served");
    const person = attach(served.hub, avery, "branch-avery", { modelId: created.branch.modelId });
    await settle();
    expect(person.client.branchesAvailable()).toBe(true);
    expect(person.client.mergeAvailable()).toBe(false);
    const answer = await person.client.mergeRequest({ type: "merge_preview" });
    expect(answer.type).toBe("merge_refused");
  });
});
