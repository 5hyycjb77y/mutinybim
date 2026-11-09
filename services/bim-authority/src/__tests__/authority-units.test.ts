/**
 * @jest-environment node
 *
 * Units of the MutinyBIM authority that need no database: configuration
 * guards, owner routing and the lease keeper. A host plug-in's authorizer is
 * tested with the plug-in (host-contract.test.ts for the open ones).
 * The database-backed lease behaviour is proven by drills/in-process.ts and
 * drills/deployed.ts (see README.md, "Drills").
 */
import { createHash } from "node:crypto";
import { isForbiddenDbRef, loadConfig, servedModelId } from "../config";
import { decideRoute, isFlyMachineId } from "../routing";
import { LeaseKeeper } from "../lease";

const REF = "testref0000000000001";
const baseEnv = {
  NODE_ENV: "test" as const,
  MUTINYBIM_DB_URL: `postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`,
  MUTINYBIM_DISPOSABLE_PROJECT_REF: REF,
  MUTINYBIM_SUPABASE_URL: `https://${REF}.supabase.co`,
  BIM_AUTHORITY_SERVED_MODELS: "demo-b,site-7301-b",
};

describe("configuration", () => {
  it("a laptop test authority takes a database and sign-ins on this machine only, and is refused on Fly", () => {
    const local = {
      NODE_ENV: "test" as const,
      MUTINYBIM_LOCAL_STACK: "1",
      MUTINYBIM_DB_URL: "postgresql://postgres:x@127.0.0.1:55732/postgres",
      MUTINYBIM_SUPABASE_URL: "http://127.0.0.1:54321",
      BIM_AUTHORITY_SERVED_MODELS: "local",
    };
    expect(loadConfig(local).testAuthUrl).toBe("http://127.0.0.1:54321");
    expect(loadConfig(local).local).toBe(true);
    expect(() => loadConfig({ ...local, MUTINYBIM_DB_URL: `postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres` })).toThrow(/must be on this machine/);
    expect(() => loadConfig({ ...local, FLY_APP_NAME: "mutinybim-example" })).toThrow(/refused on Fly/);
    expect(() => loadConfig({ ...local, MUTINYBIM_LOCAL_STACK: "0" })).toThrow(/MUTINYBIM_DISPOSABLE_PROJECT_REF is required/);
    expect(() => loadConfig({ ...baseEnv, MUTINYBIM_SUPABASE_URL: "http://127.0.0.1:54321" })).toThrow(/must be https:\/\/<ref>\.supabase\.co/);
  });

  it("needs a sign-in source: a host plug-in, test logins, or both", () => {
    const { MUTINYBIM_SUPABASE_URL: _testLogins, ...noLogins } = baseEnv;
    expect(() => loadConfig(noLogins)).toThrow(/no sign-in source: set MUTINYBIM_AUTHORIZER_MODULE/);
    expect(loadConfig({ ...noLogins, MUTINYBIM_AUTHORIZER_MODULE: "./src/host/single-user.ts" }).hostModule).toBe("./src/host/single-user.ts");
    expect(loadConfig(baseEnv).hostModule).toBeNull();
  });

  it("serves only the listed models, through aliases", () => {
    const config = loadConfig({ ...baseEnv, BIM_AUTHORITY_MODEL_ALIASES: "site-7301=site-7301-b" });
    expect(servedModelId(config, "site-7301")).toBe("site-7301-b");
    expect(servedModelId(config, "demo-b")).toBe("demo-b");
    expect(servedModelId(config, "demo-a")).toBeNull();
    expect(config.preload).toEqual([]);
  });

  it("serves a host's on-demand models only through the host's answer", () => {
    const config = loadConfig(baseEnv);
    expect(servedModelId(config, "project-42")).toBeNull();
    const onDemand = { ...config, servesOnDemand: (id: string) => /^project-[0-9]+$/.test(id) };
    expect(servedModelId(onDemand, "project-42")).toBe("project-42");
    expect(servedModelId(onDemand, "project-42~b1")).toBe("project-42~b1");
    expect(servedModelId(onDemand, "project-x")).toBeNull();
  });

  it("refuses a forbidden database (a host's production) as the authority database", () => {
    const FORBIDDEN = "forbiddenref00000003";
    const forbiddenUrl = `postgresql://postgres:x@db.${FORBIDDEN}.supabase.co:5432/postgres`;
    expect(() =>
      loadConfig({ ...baseEnv, MUTINYBIM_FORBIDDEN_DB_REFS: `other0000000000000004, ${FORBIDDEN}`, MUTINYBIM_DISPOSABLE_PROJECT_REF: FORBIDDEN, MUTINYBIM_DB_URL: forbiddenUrl, MUTINYBIM_SUPABASE_URL: "https://hostref0000000000002.supabase.co" }),
    ).toThrow(/refusing a forbidden database/);
    expect(() => loadConfig({ ...baseEnv, MUTINYBIM_FORBIDDEN_DB_REFS: FORBIDDEN, MUTINYBIM_DB_URL: forbiddenUrl })).toThrow(/refusing a forbidden database/);
    expect(loadConfig({ ...baseEnv, MUTINYBIM_FORBIDDEN_DB_REFS: FORBIDDEN }).dbRef).toBe(REF);

    // A host plug-in lists its production as digests, never the ref itself; a ref whose digest is listed is refused.
    const digests = [createHash("sha256").update(FORBIDDEN).digest("hex")];
    expect(() => loadConfig({ ...baseEnv, MUTINYBIM_DISPOSABLE_PROJECT_REF: FORBIDDEN, MUTINYBIM_DB_URL: forbiddenUrl }, { forbiddenDbRefDigests: digests })).toThrow(/refusing a forbidden database/);
    expect(loadConfig(baseEnv, { forbiddenDbRefDigests: digests }).dbRef).toBe(REF);
    expect(isForbiddenDbRef({ projectRef: FORBIDDEN, dbUrl: baseEnv.MUTINYBIM_DB_URL }, [], digests)).toBe(true);
    expect(isForbiddenDbRef({ dbUrl: forbiddenUrl }, [], digests)).toBe(true);
    expect(isForbiddenDbRef({ dbUrl: `postgresql://postgres.${FORBIDDEN}:x@aws-0-us-east-1.pooler.supabase.com:5432/postgres` }, [], digests)).toBe(true);
    expect(isForbiddenDbRef({ projectRef: REF, dbUrl: baseEnv.MUTINYBIM_DB_URL }, [], digests)).toBe(false);
    expect(isForbiddenDbRef({ projectRef: REF, dbUrl: baseEnv.MUTINYBIM_DB_URL })).toBe(false);
  });

  it("requires renewals to fit twice inside the lease", () => {
    expect(() => loadConfig({ ...baseEnv, BIM_AUTHORITY_LEASE_TTL_MS: "6000", BIM_AUTHORITY_LEASE_RENEW_MS: "3000" })).toThrow(/less than half/);
    const config = loadConfig(baseEnv);
    expect(config.leaseTtlMs).toBe(10_000);
    expect(config.leaseRenewMs).toBe(3_000);
  });

  it("gives every process start its own owner, so a restart is a new ownership term", () => {
    const env = { ...baseEnv, FLY_MACHINE_ID: "874792ea5494d8" };
    const a = loadConfig(env);
    const b = loadConfig(env);
    expect(a.owner).not.toBe(b.owner);
    expect(a.owner.startsWith("874792ea5494d8/")).toBe(true);
  });

  it("preloads only an explicit list of served models", () => {
    expect(() => loadConfig({ ...baseEnv, BIM_AUTHORITY_PRELOAD: "all" })).toThrow(/not served/);
    expect(loadConfig({ ...baseEnv, BIM_AUTHORITY_PRELOAD: "demo-b" }).preload).toEqual(["demo-b"]);
  });
});

describe("owner routing", () => {
  const self = "874792ea5494d8";
  const other = "2879170f141438";
  it("serves locally when the lease is free, expired or ours", () => {
    expect(decideRoute({ selfMachine: self, holder: null, alreadyReplayed: false })).toEqual({ kind: "local" });
    expect(decideRoute({ selfMachine: self, holder: { holderMachine: other, live: false }, alreadyReplayed: false })).toEqual({ kind: "local" });
    expect(decideRoute({ selfMachine: self, holder: { holderMachine: self, live: true }, alreadyReplayed: false })).toEqual({ kind: "local" });
  });
  it("replays to the live owner found in the database", () => {
    expect(decideRoute({ selfMachine: self, holder: { holderMachine: other, live: true }, alreadyReplayed: false })).toEqual({ kind: "replay", machine: other });
  });
  it("asks the client to retry instead of replaying twice", () => {
    expect(decideRoute({ selfMachine: self, holder: { holderMachine: other, live: true }, alreadyReplayed: true })).toEqual({ kind: "retry" });
  });
  it("only well-formed machine ids reach a replay header", () => {
    expect(isFlyMachineId(other)).toBe(true);
    expect(isFlyMachineId("instance=x\r\nset-cookie: a")).toBe(false);
  });
});

describe("lease keeper", () => {
  function keeperWith(renew: () => Promise<boolean>) {
    let t = 0;
    const lost: string[] = [];
    const keeper = new LeaseKeeper("m", { renewLease: renew }, 10_000, 3_000, (reason) => lost.push(reason), () => t);
    return { keeper, lost, advance: (ms: number) => (t += ms) };
  }

  it("keeps the model while renewals succeed", async () => {
    const { keeper, lost, advance } = keeperWith(async () => true);
    for (let i = 0; i < 5; i++) {
      advance(3_000);
      await keeper.tick();
    }
    expect(lost).toEqual([]);
    expect(keeper.fresh()).toBe(true);
    expect(keeper.stats.renewals).toBe(5);
  });

  it("gives the model up the moment a renewal is refused", async () => {
    const { keeper, lost, advance } = keeperWith(async () => false);
    advance(3_000);
    await keeper.tick();
    expect(lost).toEqual(["renewal_refused"]);
    expect(keeper.fresh()).toBe(false);
  });

  it("after a pause longer than the lease, gives up before even asking the database", async () => {
    const renew = jest.fn(async () => true);
    const { keeper, lost, advance } = keeperWith(renew);
    advance(25_000); // the process was stopped for 25 s
    expect(keeper.fresh()).toBe(false);
    await keeper.tick();
    expect(lost).toEqual(["renewal_deadline_passed"]);
    expect(renew).not.toHaveBeenCalled();
  });

  it("retries a failed renewal while there is time, then gives up", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { keeper, lost, advance } = keeperWith(async () => {
      throw new Error("database unreachable");
    });
    advance(3_000);
    await keeper.tick();
    expect(lost).toEqual([]);
    advance(4_500); // 7.5 s since the last good renewal: inside the lease but past the safety margin
    await keeper.tick();
    expect(lost).toEqual(["renewal_deadline_passed"]);
  });
});
