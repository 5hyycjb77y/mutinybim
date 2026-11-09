/**
 * @jest-environment node
 *
 * The model server's host plug-in point (src/host): what a host module must
 * export, what the loader refuses at start, how sign-ins are routed to the
 * host or to test logins, and the open example host. Any host (the open
 * examples, or a product's private one) is held to the same checks:
 * `asHostModule` + `assertModelServerHost` run on every module the server loads.
 */
import { NO_MODEL_ACCESS } from "@permitzip/bim-sync";
import { asHostModule, assertModelServerHost, createHost, loadModelServerHostModule } from "../host/load";
import { supabaseSignIn, type ModelServerHostContext } from "../host/contract";
import * as singleUser from "../host/single-user";
import { LoginVerifier } from "../auth/verify";
import type { Sql } from "../pg-store";

const verified: { keys: string; issuer: string; audience: string }[] = [];
jest.mock("jose", () => ({
  createRemoteJWKSet: (url: URL) => url.href,
  jwtVerify: async (token: string, keys: string, options: { issuer: string; audience: string }) => {
    verified.push({ keys, ...options });
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return { payload };
  },
}));

function context(env: Record<string, string>): ModelServerHostContext {
  const unused = async () => Promise.reject(new Error("not used"));
  return { env, local: false, sql: (async () => []) as unknown as Sql, hostProjects: { hostProjectOf: async () => null }, provisioner: { provision: unused }, fetch: unused };
}

const token = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

const SINGLE = {
  MUTINYBIM_SINGLE_USER_ID: "u-avery",
  MUTINYBIM_SINGLE_USER_ISSUER: "https://auth.example.test/issuer",
  MUTINYBIM_SINGLE_USER_JWKS_URL: "https://auth.example.test/jwks.json",
};

describe("host module loading", () => {
  it("no module configured is no host", async () => {
    expect(await loadModelServerHostModule(undefined)).toBeNull();
    expect(await loadModelServerHostModule("")).toBeNull();
  });

  it("a relative path is resolved from the working directory as a file URL; a package name is imported as it is", async () => {
    const asked: string[] = [];
    const importer = async (specifier: string) => (asked.push(specifier), singleUser);
    await loadModelServerHostModule("./hosts/acme.ts", "/srv/model-server", importer);
    await loadModelServerHostModule("/opt/hosts/acme.ts", "/srv/model-server", importer);
    await loadModelServerHostModule("@acme/model-server-host", "/srv/model-server", importer);
    expect(asked).toEqual(["file:///srv/model-server/hosts/acme.ts", "file:///opt/hosts/acme.ts", "@acme/model-server-host"]);
  });

  it("a module that fails to load, or doesn't keep the contract, stops the server at start", async () => {
    await expect(loadModelServerHostModule("./missing.ts", "/srv", async () => Promise.reject(new Error("Cannot find module")))).rejects.toThrow(/could not load MUTINYBIM_AUTHORIZER_MODULE \.\/missing\.ts: Cannot find module/);
    expect(() => asHostModule(null, "m")).toThrow(/did not load as a module/);
    expect(() => asHostModule({ default: {} }, "m")).toThrow(/must export createModelServerHost/);
    expect(() => asHostModule({ createModelServerHost: () => null, forbiddenDbRefDigests: ["not-a-digest"] }, "m")).toThrow(/SHA-256 hex digests/);
    expect(asHostModule({ createModelServerHost: () => null, forbiddenDbRefDigests: ["a".repeat(64)] }, "m").forbiddenDbRefDigests).toEqual(["a".repeat(64)]);
  });

  it("a host that doesn't keep the contract is refused when it is created", async () => {
    const authorizer = () => ({ capabilities: async () => ({ ok: false as const, reason: NO_MODEL_ACCESS }) });
    const signIn = supabaseSignIn("https://auth.example.test");
    const good = { name: "acme", signIn, authorizer };
    expect(() => assertModelServerHost(good, "m")).not.toThrow();
    expect(() => assertModelServerHost(null, "m")).toThrow(/returned no host/);
    expect(() => assertModelServerHost({ ...good, name: "" }, "m")).toThrow(/needs a name/);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => assertModelServerHost({ ...good, signIn: { ...signIn, jwksUrl: "not a url" } }, "m")).toThrow(/signIn needs/);
    expect(() => assertModelServerHost({ ...good, authorizer: undefined }, "m")).toThrow(/authorizer\(projectHint\)/);
    expect(() => assertModelServerHost({ ...good, servesOnDemand: true }, "m")).toThrow(/servesOnDemand must be a function/);
    expect(() => assertModelServerHost({ ...good, mergeApprovals: { proposalFor: async () => null } }, "m")).toThrow(/mergeApprovals must answer/);
    await expect(createHost({ createModelServerHost: () => ({ ...good, name: "" }) }, context({}), "m")).rejects.toThrow(/needs a name/);
  });
});

describe("sign-in routing", () => {
  it("a token from the host's issuer is the host's; one from the test Auth is a test login; anything else is refused", async () => {
    verified.length = 0;
    const host = supabaseSignIn("https://host.example.test/");
    const verifier = new LoginVerifier({ host, testUrl: "https://testauth.example.test" });
    expect(await verifier.verify(token({ iss: "https://host.example.test/auth/v1", sub: "u-1", exp: 10 }))).toEqual({ userId: "u-1", issuer: "host", expiresAt: 10 });
    expect(await verifier.verify(token({ iss: "https://testauth.example.test/auth/v1", sub: "u-2" }))).toEqual({ userId: "u-2", issuer: "test", expiresAt: null });
    expect(verified).toEqual([
      { keys: "https://host.example.test/auth/v1/.well-known/jwks.json", issuer: "https://host.example.test/auth/v1", audience: "authenticated" },
      { keys: "https://testauth.example.test/auth/v1/.well-known/jwks.json", issuer: "https://testauth.example.test/auth/v1", audience: "authenticated" },
    ]);
    await expect(verifier.verify(token({ iss: "https://elsewhere.example.test/auth/v1", sub: "u-3" }))).rejects.toThrow(/unknown issuer/);
    await expect(new LoginVerifier({ host: null, testUrl: "https://testauth.example.test" }).verify(token({ iss: "https://host.example.test/auth/v1", sub: "u-1" }))).rejects.toThrow(/unknown issuer/);
  });

  it("a host's own issuer and audience are used as they are", async () => {
    verified.length = 0;
    const verifier = new LoginVerifier({ host: { issuer: "https://idp.example.test", jwksUrl: "https://idp.example.test/keys", audience: "mutinybim" }, testUrl: null });
    expect((await verifier.verify(token({ iss: "https://idp.example.test", sub: "u-9" }))).issuer).toBe("host");
    expect(verified).toEqual([{ keys: "https://idp.example.test/keys", issuer: "https://idp.example.test", audience: "mutinybim" }]);
  });
});

describe("the open single-user example host", () => {
  it("keeps the contract", async () => {
    const hostModule = asHostModule(singleUser, "single-user");
    const host = await createHost(hostModule, context(SINGLE), "single-user");
    expect(host.name).toBe("single-user");
    expect(host.signIn).toEqual({ issuer: SINGLE.MUTINYBIM_SINGLE_USER_ISSUER, jwksUrl: SINGLE.MUTINYBIM_SINGLE_USER_JWKS_URL, audience: "authenticated" });
    expect(host.mergeApprovals).toBeUndefined();
    expect(host.servesOnDemand).toBeUndefined();
  });

  it("the one person gets every right on every served model; anyone else is refused", async () => {
    const host = singleUser.createModelServerHost(context(SINGLE));
    const mine = await host.authorizer(null).capabilities({ userId: "u-avery", modelId: "demo", token: "t" });
    expect(mine.ok && [...mine.capabilities].sort()).toEqual(["model.edit", "model.issue", "model.read"]);
    expect(await host.authorizer("any-project").capabilities({ userId: "u-riley", modelId: "demo", token: "t" })).toEqual({ ok: false, reason: NO_MODEL_ACCESS });
  });

  it("refuses to start without its settings", () => {
    expect(() => singleUser.createModelServerHost(context({ ...SINGLE, MUTINYBIM_SINGLE_USER_ID: "" }))).toThrow(/MUTINYBIM_SINGLE_USER_ID is required/);
  });
});
