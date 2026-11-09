/**
 * @jest-environment node
 *
 * A command sent on an old head is checked only against intents on the
 * elements it changes. Before 2026-10-23 every latest intent in the whole
 * stretch since its base was re-checked against the new model: a client with
 * a backlog (thousands of changesets behind) paid for all of them on every
 * edit, and an intent on some unrelated element that a later, legitimate
 * change had moved refused the edit as "would undo X's edit".
 */
import { planCommit, type Actor, type Changeset, type CommandRequest } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;
const me: Actor = { id: "me", name: "Me", kind: "human" };
const other: Actor = { id: "other", name: "Other", kind: "human" };

describe("intent checks on a stale base", () => {
  const head = createDemoModel();
  const taps = Object.values(head.elements).filter((el) => el.kind === "tap");
  const [mine, theirs] = taps;
  if (!mine || !theirs || mine.kind !== "tap") throw new Error("demo model needs two taps");
  const theirsId = theirs.id;

  function unrelated(count: number): Changeset[] {
    // Another person's intents on an element this command never touches, already moved on at the head.
    return Array.from({ length: count }, (_, i) => ({
      revision: head.revision + 1 + i,
      baseRevision: head.revision + i,
      idempotencyKey: `other-${i}-key`,
      actor: other,
      command: { type: "slide_branch", tapId: theirsId, s: 1 },
      elements: [],
      readSet: {},
      authored: [],
      intents: [{ kind: "field_equals", elementId: theirsId, field: "s", value: 999_000 + i }],
      rebased: false,
      committedAt: "2026-10-23T00:00:00.000Z",
    })) as unknown as Changeset[];
  }

  const request = (sinceLength: number): CommandRequest => ({
    idempotencyKey: `mine-${sinceLength}-key`,
    baseRevision: head.revision,
    actor: me,
    clientSessionId: "me-session",
    command: { type: "slide_branch", tapId: mine.id, s: mine.s + 0.25 * FT },
  });

  it("commits an edit to one element even when an unrelated element's old intent no longer holds", () => {
    const since = unrelated(1);
    const decision = planCommit({ ...head, revision: head.revision + 1 } as typeof head, since, request(1));
    expect(decision.ok).toBe(true);
  });

  it("still refuses an edit that breaks another person's intent on the element it changes", () => {
    const since = unrelated(1).map((cs) => ({ ...cs, intents: [{ kind: "field_equals" as const, elementId: mine.id, field: "s", value: mine.s }] }));
    const decision = planCommit({ ...head, revision: head.revision + 1 } as typeof head, since as Changeset[], request(2));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe("conflict");
  });

  it("decides a command thousands of changesets behind without re-checking unrelated intents", () => {
    const since = unrelated(5000);
    const decision = planCommit({ ...head, revision: head.revision + since.length } as typeof head, since, request(5000));
    expect(decision.ok).toBe(true);
  });
});
