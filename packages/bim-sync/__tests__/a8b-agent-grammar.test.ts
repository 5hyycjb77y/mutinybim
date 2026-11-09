/**
 * @jest-environment node
 *
 * Round 8b lane A: the kernel's agent-subject parser and the model server's
 * agent principal read `agent:<user>:<run>` the same way, so an author built
 * from a changeset actor names the person the server bound the agent to.
 * Fails on round 8's code: the kernel has no parseAgentSubject.
 */
import { authorFromActor, parseAgentSubject } from "@permitzip/bim-kernel";
import { agentActor, agentOnBehalfOf } from "../src/agent-principal";

const IDS = ["agent:u1:run-1", "agent:u1:", "agent::r", "agent:u1:bad run", "agent:u-2:a.b_c-9", "u1", "agent:u1:r:extra", `agent:u1:${"r".repeat(81)}`];

describe("a8b-agent-grammar", () => {
  it.each(IDS)("agrees on %s", (id) => {
    expect(parseAgentSubject(id)?.personSubject ?? null).toBe(agentOnBehalfOf(id));
  });

  it("an agent actor from the server becomes an agent author for that person", () => {
    const actor = agentActor("u1", "run-7", "Model agent");
    expect(authorFromActor(actor, "host").onBehalfOf?.subject).toBe(agentOnBehalfOf(actor.id));
  });
});
