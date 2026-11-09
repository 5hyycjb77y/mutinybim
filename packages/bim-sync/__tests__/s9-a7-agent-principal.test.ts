/**
 * @jest-environment node
 *
 * Round 9 lane S9, A7 follow-ups: the model server reads agent ids with the
 * kernel's parser (one grammar, not two copies), and a client's actor that
 * names another sign-in system than the session's is refused. Fails on round
 * 8b's code: `principalFor` ignores `provider` (and the schema dropped it).
 */
import { actorSchema, parseAgentSubject } from "@permitzip/bim-kernel";
import { agentOnBehalfOf, principalFor } from "../src/agent-principal";

describe("s9-a7-agent-principal", () => {
  it("delegates to the kernel's agent grammar", () => {
    for (const id of ["agent:u1:run-1", "agent:u1:", "agent::r", "u1", "agent:u-2:a.b_c-9"]) expect(agentOnBehalfOf(id)).toBe(parseAgentSubject(id)?.personSubject ?? null);
  });

  it("a person editing as themselves, and their agent, are allowed as before", () => {
    expect(principalFor({ id: "u1", name: "J. Rao", kind: "human" }, "u1")).toEqual({ ok: true, actorId: "u1" });
    expect(principalFor({ id: "agent:u1:run-1", name: "Agent", kind: "agent" }, "u1")).toEqual({ ok: true, actorId: "agent:u1:run-1" });
  });

  it("an actor naming another provider than the session's is refused", () => {
    const actor = actorSchema.parse({ id: "u1", name: "J. Rao", kind: "human", provider: "acme.oidc" });
    expect(principalFor(actor, "u1")).toMatchObject({ ok: false });
    expect(principalFor(actor, "u1", "host")).toMatchObject({ ok: false });
    expect(principalFor(actor, "u1", "acme.oidc")).toEqual({ ok: true, actorId: "u1" });
  });
});
