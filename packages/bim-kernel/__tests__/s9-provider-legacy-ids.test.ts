/**
 * @jest-environment node
 *
 * A host renames its identity provider: new records carry the new id, and
 * authors and envelopes stored under the earlier id still resolve and verify
 * through the same provider, forever. Fails on the code before `legacyIds`:
 * an envelope under the earlier id was "signed through …, which this app can't check".
 */
import { IdentityProviderError, IdentityProviderRegistry, type IdentityProviderDef } from "@permitzip/bim-kernel";

function provider(over: Partial<IdentityProviderDef> = {}): IdentityProviderDef {
  return {
    id: "host",
    legacyIds: ["oldhost"],
    label: "Host login",
    version: "1.0.0",
    algorithms: ["test-alg"],
    resolveAuthor: async (subject) => ({ author: { provider: "host", subject, kind: "person", displayName: "R. Doe" }, licences: [] }),
    verify: async (env) => ({ status: "valid", signer: env.signer }),
    ...over,
  };
}

describe("identity providers keep their earlier ids", () => {
  it("an author or envelope under the earlier id reaches the same provider; ids() lists only current ids", async () => {
    const p = provider();
    const registry = new IdentityProviderRegistry([p]);
    expect(registry.get("oldhost")).toBe(p);
    expect(registry.get("host")).toBe(p);
    expect(registry.ids()).toEqual(["unsigned", "host"]);
    expect((await registry.resolveAuthor({ provider: "oldhost", subject: "u-1", kind: "person" }))?.author.displayName).toBe("R. Doe");
  });

  it("an earlier id can't be taken by another provider, and must itself be a provider id", () => {
    expect(() => new IdentityProviderRegistry([provider(), provider({ id: "oldhost", legacyIds: [] })])).toThrow(IdentityProviderError);
    expect(() => new IdentityProviderRegistry([provider({ legacyIds: ["Not An Id"] })])).toThrow(/isn't a provider id/);
  });
});
