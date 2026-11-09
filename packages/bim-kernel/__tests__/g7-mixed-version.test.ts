/**
 * @jest-environment node
 *
 * Round 7 lane G: mixed versions. Every peer of this release advertises
 * `graph:determinations`, `graph:rules` and `graph:requirement_states`
 * (they join `gatedRecordFeatures()`); `graph:observations` stays reserved,
 * so nothing writes an observation. A writer whose server is older refuses
 * in plain words and changes nothing. A round-6-shaped peer (no graph
 * features) keeps every graph record it receives, byte for byte, including
 * fields, statuses and kinds of record this release doesn't know, and the
 * tolerant readers answer from them.
 *
 * Fails on the code before round 7: the features weren't advertised and the
 * record readers and gated writers didn't exist.
 */
import {
  executeCommand,
  gatedRecordFeatures,
  observationsWritable,
  readDeterminationBody,
  readObservationBody,
  readRuleRecord,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ModelState,
} from "../src";
import { floor, STUDY_RULES } from "./g7-fixtures";

const GRAPH = ["graph:determinations", "graph:rules", "graph:requirement_states"];
const OLDER_SERVER = (feature: string) => !feature.startsWith("graph:");
const ROUND_6_PEER = () => false;
const OLD = "the model server this model is open on is an older version that doesn't store them. Try again once the server is updated";

function attempt(m: ModelState, c: Command, policy: (f: string) => boolean) {
  return withUpgradePolicy(policy, () => executeCommand(m, c));
}

const decide = { reasoning: "Synthetic test decision.", decidedBy: "K. Example", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high" as const };

/** Graph records a newer peer wrote: a status, a field and an observation this release doesn't know. */
function newerPeersRecords(): BimElement[] {
  const base = { version: 4, authoredRev: {}, partition: { level: "", zone: "", discipline: "general" } };
  return [
    { ...base, id: "D-new", kind: "determination", schemaVersion: 3, determination: { subject: { kind: "space", id: "S101" }, key: "occupancy", value: "B", inputs: [], reasoning: "From a newer peer.", decidedBy: "A. Peer", confidence: "high", status: "contested", panel: { seats: 3 } } },
    { ...base, id: "rule:peer.r1", kind: "rule", rule: { ...STUDY_RULES[0], ruleId: "peer.r1", provider: "local", futureField: [1, 2, 3] } },
    { ...base, id: "OBS-1", kind: "observation", observation: { subject: { kind: "space", id: "S104" }, observedBy: "Site walker", at: "2026-10-30", result: "partly_meets", note: "Synthetic.", attachments: [], photoCount: 2 } },
  ] as unknown as BimElement[];
}

describe("g7 mixed versions", () => {
  it("advertises the three graph record features and never the reserved observation feature", () => {
    const features = gatedRecordFeatures();
    for (const f of GRAPH) expect(features).toContain(f);
    expect(features).not.toContain("graph:observations");
    expect(observationsWritable()).toBe(false);
  });

  it("a writer whose server is older refuses each graph write in words, and nothing changes", () => {
    const m = floor("g7-mixed-a");
    const record = attempt(m, { type: "record_determination", determinationId: "D-x", subject: { kind: "model" }, key: "sprinklered", value: true, ...decide }, OLDER_SERVER);
    expect(record).toMatchObject({ ok: false, error: { message: `Decisions can't be recorded yet: ${OLD}` } });
    const supersede = attempt(m, { type: "supersede_determination", determinationId: "D-haz-S104", newDeterminationId: "D-y", value: "light", ...decide }, OLDER_SERVER);
    expect(supersede).toMatchObject({ ok: false, error: { message: `Decisions can't be recorded yet: ${OLD}` } });
    const state = attempt(m, { type: "set_requirement_state", requirementId: "zt.code_study:exits:arch.exit_count:S101", status: "verified", by: "K. Example" }, OLDER_SERVER);
    expect(state).toMatchObject({ ok: false, error: { message: `Requirement checks can't be saved yet: ${OLD}` } });
    const rule = attempt(m, { type: "delete_local_rules", ruleIds: ["x"] }, OLDER_SERVER);
    expect(rule).toMatchObject({ ok: false, error: { message: `Code-study rules can't be saved in the model yet: ${OLD}` } });
  });

  it("a round-6-shaped peer keeps graph records it can't write, untouched by its own edits", () => {
    const m0 = floor("g7-mixed-b");
    const received = newerPeersRecords();
    const m: ModelState = { ...m0, elements: { ...m0.elements, ...Object.fromEntries(received.map((e) => [e.id, e])) } };
    const r = attempt(m, { type: "create_level", levelId: "L2", name: "Level 2", elevationMm: 4000 }, ROUND_6_PEER);
    if (!r.ok) throw new Error(r.error.message);
    for (const e of received) expect(r.model.elements[e.id]).toBe(e);
    const r2 = attempt(r.model, { type: "edit_space", spaceId: "S101", name: "Open office" }, ROUND_6_PEER);
    if (!r2.ok) throw new Error(r2.error.message);
    for (const e of received) expect(JSON.stringify(r2.model.elements[e.id])).toBe(JSON.stringify(e));
  });

  it("the tolerant readers keep what they don't know", () => {
    const [det, rule, obs] = newerPeersRecords() as unknown as { determination?: unknown; rule?: unknown; observation?: unknown }[];
    const d = readDeterminationBody(det?.determination);
    expect(d.ok && d.value).toMatchObject({ status: "contested", panel: { seats: 3 } });
    const r = readRuleRecord(rule?.rule);
    expect(r.ok && r.value).toMatchObject({ ruleId: "peer.r1", futureField: [1, 2, 3] });
    const o = readObservationBody(obs?.observation);
    expect(o.ok && o.value).toMatchObject({ result: "partly_meets", photoCount: 2 });
    expect(readObservationBody({ subject: { kind: "space" } })).toEqual({ ok: false, reason: "an observation needs who observed it and when" });
  });
});
