/**
 * @jest-environment node
 *
 * Round 11 A11 (D5; the product owner's question 8 pending, default data only): a host
 * with the default setting refuses an add-on that runs code, in plain words,
 * and a "data" add-on that puts rows at a point whose rows are code is
 * refused too. One setting flips it for a standalone operator who installs
 * code as trusted software. Fails on round 10's code: there was no tier.
 */
import { DATA_ONLY_POLICY } from "@permitzip/bim-kernel/packs";
import { checkOutsidePackage } from "../src/install";
import { doorAddon, LICENCES, registry, signedPackage } from "./fixtures/a11-outside";

describe("a11 code tier refused in host", () => {
  it("the default host refuses a code add-on with the words", async () => {
    expect(DATA_ONLY_POLICY.codeTier).toBe("refuse");
    const outcome = await checkOutsidePackage(signedPackage({ tier: "code" }), { registry: registry(), licences: LICENCES, hostName: "Example Host" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refused).toBe("Acme doors runs code. Example Host installs data add-ons only (classes, parameter sets, tables, zone purposes); add-ons that run code aren't allowed here.");
  });

  it("a data add-on can't add rows at a code point", async () => {
    const addon = doorAddon({ extraContributions: [{ point: "kernel.network_adapter", version: 1, items: [{ id: "acme.flow" }] }] });
    const outcome = await checkOutsidePackage(signedPackage({ addon }), { registry: registry(), licences: LICENCES });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.checks.conformance.problems.join(" ")).toContain('Acme doors adds rows to "kernel.network_adapter", which isn\'t a data point; rows there need code.');
  });

  it("a standalone operator's one setting lets it through as trusted software, built by the operator", async () => {
    const outcome = await checkOutsidePackage(signedPackage({ tier: "code" }), { registry: registry(), licences: LICENCES, policy: { codeTier: "trusted_operator" } });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.addons.map((a) => ({ tier: a.tier, pack: a.pack }))).toEqual([{ tier: "code", pack: null }]);
  });
});
