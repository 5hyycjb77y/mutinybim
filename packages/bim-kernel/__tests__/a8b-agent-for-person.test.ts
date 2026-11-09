/**
 * @jest-environment node
 *
 * Round 8b lane A: an agent's act carries the agent and the person it acted
 * for. Built on the changeset `Actor` the model server already uses
 * (`agent:<user>:<run>`), not a parallel identity. Fails on round 8's code:
 * there is no authorship module.
 */
import { AuthorshipWriteError, agentAuthor, authorFromActor, authorWords, parseAgentSubject, readAuthorRef, writeAuthorRef, type AuthorRef } from "@permitzip/bim-kernel";

const PERSON: AuthorRef = { provider: "host", subject: "6f1c2a90-0000-4000-8000-000000000001", kind: "person", displayName: "R. Doe" };

describe("a8b-agent-for-person", () => {
  it("maps a person actor and an agent actor to authors under the session's provider", () => {
    expect(authorFromActor({ id: PERSON.subject, name: "R. Doe", kind: "human" }, "host")).toEqual(PERSON);
    const agent = authorFromActor({ id: `agent:${PERSON.subject}:run-42`, name: "Model agent", kind: "agent" }, "host");
    expect(agent.kind).toBe("agent");
    expect(agent.onBehalfOf).toEqual({ provider: "host", subject: PERSON.subject, kind: "person" });
    expect(authorWords(agent)).toBe(`Model agent (agent for ${PERSON.subject})`);
    expect(writeAuthorRef(agent).onBehalfOf?.subject).toBe(PERSON.subject);
  });

  it("builds an agent for a person and reads it back the same", () => {
    const agent = agentAuthor(PERSON, "thread_7.turn-3", "Building Model agent");
    expect(agent.subject).toBe(`agent:${PERSON.subject}:thread_7.turn-3`);
    expect(parseAgentSubject(agent.subject)).toEqual({ personSubject: PERSON.subject, runId: "thread_7.turn-3" });
    const read = readAuthorRef(writeAuthorRef(agent));
    if (!read.ok) throw new Error(read.reason);
    expect(read.value).toEqual(agent);
    expect(read.notes).toEqual([]);
  });

  it("the strict writer refuses an agent with no person, an agent for an agent, and a person on behalf of anyone", () => {
    const orphan = authorFromActor({ id: "agent-account-1", name: "Bot", kind: "agent" }, "host");
    expect(orphan.onBehalfOf).toBeUndefined();
    expect(() => writeAuthorRef(orphan)).toThrow(/doesn't name the person it acted for/);

    const agent = agentAuthor(PERSON, "r1");
    expect(() => writeAuthorRef({ ...agent, onBehalfOf: agent })).toThrow(AuthorshipWriteError);
    expect(() => agentAuthor(agent, "r2")).toThrow(/not for another agent/);
    expect(() => writeAuthorRef({ ...PERSON, onBehalfOf: PERSON })).toThrow(/only an agent acts on behalf/);
  });

  it("the tolerant reader refuses a chain of agents", () => {
    const nested = { provider: "host", subject: "agent:a:r", kind: "agent", onBehalfOf: { provider: "host", subject: "agent:b:r", kind: "agent", onBehalfOf: PERSON } };
    expect(readAuthorRef(nested).ok).toBe(false);
  });
});
