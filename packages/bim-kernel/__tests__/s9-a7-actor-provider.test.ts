/**
 * @jest-environment node
 *
 * Round 9 lane S9, A7 follow-up (1): a changeset actor may name the identity
 * provider that authorized it, so a server serving more than one login
 * system records whose person it was. Absent, the session's provider is
 * used, exactly as before. Fails on round 8b's code: `actorSchema` strips
 * `provider` and `authorFromActor` always uses the session's.
 */
import { actorSchema, authorFromActor } from "@permitzip/bim-kernel";

describe("s9-a7-actor-provider", () => {
  it("keeps a well-formed provider and refuses a malformed one", () => {
    expect(actorSchema.parse({ id: "u-1", name: "J. Rao", kind: "human", provider: "acme.oidc" })).toEqual({ id: "u-1", name: "J. Rao", kind: "human", provider: "acme.oidc" });
    expect(actorSchema.safeParse({ id: "u-1", name: "J. Rao", kind: "human", provider: "Acme OIDC" }).success).toBe(false);
  });

  it("an old actor (no provider) reads as before", () => {
    expect(actorSchema.parse({ id: "u-1", name: "J. Rao", kind: "human" })).toEqual({ id: "u-1", name: "J. Rao", kind: "human" });
    expect(authorFromActor({ id: "u-1", name: "J. Rao", kind: "human" }, "host")).toEqual({ provider: "host", subject: "u-1", kind: "person", displayName: "J. Rao" });
  });

  it("the actor's provider wins over the session's, for the agent's person too", () => {
    expect(authorFromActor({ id: "agent:u-1:run-9", name: "Agent", kind: "agent", provider: "acme.oidc" }, "host")).toEqual({
      provider: "acme.oidc",
      subject: "agent:u-1:run-9",
      kind: "agent",
      displayName: "Agent",
      onBehalfOf: { provider: "acme.oidc", subject: "u-1", kind: "person" },
    });
  });
});
