/** @jest-environment node */
import { inspect } from "node:util";
import type postgres from "postgres";
import {
  NativeSessionStoreError,
  PgNativeSessionStore,
  type NativeSessionOptions,
  type SignInProvider,
  type VerifiedNativeIdentity,
} from "../native-session-store";

const transactionId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const token = "A".repeat(43);
const provider: SignInProvider = {
  issuer: "https://issuer.example.invalid/Realm",
  clientId: "synthetic-client",
  redirectUri: "https://authority.example.invalid/sign-in/callback",
};
const identity: VerifiedNativeIdentity = {
  issuer: provider.issuer,
  subject: "synthetic-subject",
  displayName: "Synthetic Person",
};

/**
 * Script only driver results and transaction completion. No SQL parser or
 * in-memory implementation of identity/session semantics: those are exercised
 * independently against PostgreSQL by the acceptance fixture.
 */
function scriptedDatabase(rows: unknown[][] = [], failure?: { at: "begin" | "query" | "commit"; value: unknown }) {
  const parameters: unknown[][] = [];
  const tx = jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    parameters.push(values);
    if (failure?.at === "query") throw failure.value;
    const next = rows.shift();
    if (!next) throw new Error("Test driver has no scripted result");
    return next;
  });
  const begin = jest.fn(async (_options: string, work: (connection: unknown) => Promise<unknown>) => {
    if (failure?.at === "begin") throw failure.value;
    const result = await work(tx);
    if (failure?.at === "commit") throw failure.value;
    return result;
  });
  return { sql: { begin } as unknown as postgres.Sql, begin, tx, parameters };
}

function completedExistingPersonRows(issuer = provider.issuer): unknown[][] {
  return [
    [{ issuer, status: "claimed" }],
    [],
    [{ present: 1 }],
    [{ person_id: personId }],
    [{ expires_at: new Date("2040-01-01T08:00:00.000Z") }],
    [{ transaction_id: transactionId }],
  ];
}

describe("native session request boundaries", () => {
  const marker = "native-input-redaction-7d253f";
  const invalidText = ["", ...["\0", "\ud800", "\udc00"].map(character => marker + character + "value")];
  const malformedTokens: unknown[] = [
    "", "A".repeat(42), "A".repeat(44), `${token}\n`, `${token}\r\n`,
    `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, `${"A".repeat(42)}/`,
    `${"A".repeat(42)} `, `${"A".repeat(42)}\0`, "é".repeat(43),
    undefined, null, 123, { toString: () => token },
  ];

  it.each(malformedTokens.map((value, index) => [index, value] as const))(
    "rejects malformed opaque values before database IO (%s)", async (_index, value) => {
      const db = scriptedDatabase();
      const store = new PgNativeSessionStore(db.sql);
      const bad = value as string;
      await expect(store.claimSignIn({ state: bad, browserBinding: token })).resolves.toEqual({ status: "unavailable" });
      await expect(store.claimSignIn({ state: token, browserBinding: bad })).resolves.toEqual({ status: "unavailable" });
      await expect(store.completeSignIn({ transactionId, claimToken: bad, identity })).resolves.toEqual({ status: "unavailable" });
      await expect(store.abandonSignIn({ transactionId, claimToken: bad })).resolves.toBeUndefined();
      await expect(store.resolveSession(bad)).resolves.toBeNull();
      await expect(store.revokeSession(bad)).resolves.toBeUndefined();
      expect(db.begin).not.toHaveBeenCalled();
      expect(db.tx).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-uuid", `${transactionId}\n`, `${transactionId}\r\n`, `${transactionId} `])(
    "rejects malformed claim IDs before database IO (%#)", async (badId) => {
      const db = scriptedDatabase();
      const store = new PgNativeSessionStore(db.sql);
      await expect(store.completeSignIn({ transactionId: badId, claimToken: token, identity })).resolves.toEqual({ status: "unavailable" });
      await expect(store.abandonSignIn({ transactionId: badId, claimToken: token })).resolves.toBeUndefined();
      expect(db.begin).not.toHaveBeenCalled();
    },
  );

  it.each(["issuer", "clientId", "redirectUri"] as const)(
    "rejects invalid provider %s without database IO or reflection", async (field) => {
      for (const bad of invalidText) {
        const db = scriptedDatabase();
        const store = new PgNativeSessionStore(db.sql);
        let caught: unknown;
        try { await store.startSignIn({ ...provider, [field]: bad }); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(TypeError);
        expect(inspect(caught)).not.toContain(marker);
        expect(db.begin).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["issuer", "subject", "displayName"] as const)(
    "rejects invalid verified %s before database IO or reflection", async (field) => {
      for (const bad of invalidText) {
        const db = scriptedDatabase();
        const store = new PgNativeSessionStore(db.sql);
        let caught: unknown;
        try {
          await store.completeSignIn({ transactionId, claimToken: token, identity: { ...identity, [field]: bad } });
        } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(TypeError);
        expect(inspect(caught)).not.toContain(marker);
        expect(db.begin).not.toHaveBeenCalled();
      }
    },
  );

  it("enforces UTF-8 byte limits as well as display-name character limits", async () => {
    const db = scriptedDatabase();
    const store = new PgNativeSessionStore(db.sql);
    await expect(store.startSignIn({ ...provider, issuer: "é".repeat(501) })).rejects.toBeInstanceOf(TypeError);
    await expect(store.startSignIn({ ...provider, clientId: "é".repeat(1001) })).rejects.toBeInstanceOf(TypeError);
    await expect(store.startSignIn({ ...provider, redirectUri: "é".repeat(1001) })).rejects.toBeInstanceOf(TypeError);
    await expect(store.completeSignIn({ transactionId, claimToken: token,
      identity: { ...identity, subject: "é".repeat(501) } })).rejects.toBeInstanceOf(TypeError);
    await expect(store.completeSignIn({ transactionId, claimToken: token,
      identity: { ...identity, displayName: "a".repeat(201) } })).rejects.toBeInstanceOf(TypeError);
    await expect(store.completeSignIn({ transactionId, claimToken: token,
      identity: { ...identity, displayName: "😀".repeat(201) } })).rejects.toBeInstanceOf(TypeError);
    expect(db.begin).not.toHaveBeenCalled();
  });
});

describe("native session lifetime configuration", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 601])(
    "refuses an invalid transaction TTL (%s)", (seconds) => {
      const db = scriptedDatabase();
      expect(() => new PgNativeSessionStore(db.sql, { transactionTtlSeconds: seconds })).toThrow(TypeError);
      expect(db.begin).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_401])(
    "refuses an invalid session TTL (%s)", (seconds) => {
      const db = scriptedDatabase();
      expect(() => new PgNativeSessionStore(db.sql, { sessionTtlSeconds: seconds })).toThrow(TypeError);
      expect(db.begin).not.toHaveBeenCalled();
    },
  );
  it.each<NativeSessionOptions>([{}, { transactionTtlSeconds: 1, sessionTtlSeconds: 1 },
    { transactionTtlSeconds: 600, sessionTtlSeconds: 86_400 }])(
    "accepts defaults and inclusive lifetime boundaries (%#)", (options) => {
      const db = scriptedDatabase();
      expect(() => new PgNativeSessionStore(db.sql, options)).not.toThrow();
      expect(db.begin).not.toHaveBeenCalled();
    },
  );
});

describe("native session values and response boundaries", () => {
  it("passes exact provider strings unchanged and returns independent 32-byte opaque values", async () => {
    const expiresAt = new Date("2040-01-01T00:05:00.000Z");
    const db = scriptedDatabase([[{ expires_at: expiresAt }], [{ expires_at: expiresAt }]]);
    const store = new PgNativeSessionStore(db.sql);
    const exactProvider = { issuer: "https://ISSUER.example.invalid/e\u0301/", clientId: " Client With Spaces ",
      redirectUri: "https://Authority.example.invalid/Callback?next=%2F" };
    const first = await store.startSignIn(exactProvider);
    const second = await store.startSignIn(exactProvider);
    expect(Object.keys(first).sort()).toEqual([
      "browserBinding", "codeChallenge", "expiresAt", "nonce", "state", "transactionId",
    ].sort());
    expect(first.expiresAt).toBe(expiresAt);
    const generated = [first.state, first.browserBinding, first.nonce, first.codeChallenge,
      second.state, second.browserBinding, second.nonce, second.codeChallenge];
    for (const value of generated) {
      expect(value).toHaveLength(43);
      expect(Buffer.from(value, "base64url")).toHaveLength(32);
      expect(Buffer.from(value, "base64url").toString("base64url")).toBe(value);
    }
    expect(new Set(generated).size).toBe(generated.length);
    expect(first.transactionId).not.toBe(second.transactionId);
    const writtenValues = db.parameters.flat();
    for (const value of Object.values(exactProvider)) expect(writtenValues).toContain(value);
    for (const raw of [first.state, first.browserBinding, second.state, second.browserBinding]) {
      expect(writtenValues).not.toContain(raw);
    }
  });

  it("does not normalize an issuer to make a claimed transaction match", async () => {
    for (const changed of [provider.issuer.toLowerCase(), `${provider.issuer}/`, ` ${provider.issuer}`]) {
      const db = scriptedDatabase([[{ issuer: provider.issuer, status: "claimed" }]]);
      const store = new PgNativeSessionStore(db.sql);
      await expect(store.completeSignIn({ transactionId, claimToken: token,
        identity: { ...identity, issuer: changed } })).resolves.toEqual({ status: "unavailable" });
      expect(db.tx).toHaveBeenCalledTimes(1);
    }
  });

  it("passes exact verified subject bytes through and returns a session only after the transaction resolves", async () => {
    const exactIdentity = { ...identity, subject: " Subject-e\u0301-😀 " };
    const db = scriptedDatabase(completedExistingPersonRows());
    const normalBegin = db.begin.getMockImplementation()!;
    let finishCommit!: () => void;
    const committed = new Promise<void>((resolve) => { finishCommit = resolve; });
    let workDone!: () => void;
    const reachedCommit = new Promise<void>((resolve) => { workDone = resolve; });
    db.begin.mockImplementation(async (options, work) => {
      const result = await normalBegin(options, work);
      workDone();
      await committed;
      return result;
    });
    const store = new PgNativeSessionStore(db.sql);
    let replyReceived = false;
    const pending = store.completeSignIn({ transactionId, claimToken: token, identity: exactIdentity })
      .then((reply) => { replyReceived = true; return reply; });
    await reachedCommit;
    expect(replyReceived).toBe(false);
    finishCommit();
    const reply = await pending;
    expect(reply.status).toBe("issued");
    if (reply.status !== "issued") throw new Error("Expected an issued session");
    expect(reply.personId).toBe(personId);
    expect(Buffer.from(reply.sessionToken, "base64url")).toHaveLength(32);
    expect(db.parameters.flat()).toContain(exactIdentity.subject);
    expect(db.parameters.flat()).not.toContain(exactIdentity.subject.trim().normalize("NFC"));
    expect(db.parameters.flat()).not.toContain(reply.sessionToken);
  });
});

describe("native session database error redaction", () => {
  const marker = "synthetic-private-protocol-value-must-not-escape";
  function maliciousDriverError() {
    return Object.assign(new Error(marker), {
      query: `select '${marker}'`, parameters: [marker], detail: marker,
      cause: Object.assign(new Error(marker), { connectionString: marker }),
      code: marker, schema_name: marker,
    });
  }
  async function expectRedacted(pending: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try { await pending; } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NativeSessionStoreError);
    expect((caught as NativeSessionStoreError).code).toBe("native_session_storage_unavailable");
    expect(inspect(caught, { depth: 10, showHidden: true })).not.toContain(marker);
    expect(JSON.stringify(caught)).not.toContain(marker);
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(Object.keys(caught as object).sort()).toEqual(["code", "name"]);
  }

  it.each(["start", "claim", "complete", "abandon", "resolve", "revoke"] as const)(
    "redacts connection failures from %s, without logging protocol values", async (operation) => {
      const db = scriptedDatabase([], { at: "begin", value: maliciousDriverError() });
      const store = new PgNativeSessionStore(db.sql);
      const logs = ["log", "info", "warn", "error", "debug"].map((method) =>
        jest.spyOn(console, method as "log").mockImplementation(() => {}));
      const calls = {
        start: () => store.startSignIn(provider),
        claim: () => store.claimSignIn({ state: token, browserBinding: token }),
        complete: () => store.completeSignIn({ transactionId, claimToken: token, identity }),
        abandon: () => store.abandonSignIn({ transactionId, claimToken: token }),
        resolve: () => store.resolveSession(token),
        revoke: () => store.revokeSession(token),
      };
      await expectRedacted(calls[operation]());
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    },
  );

  it("redacts query failures after protocol values have been bound", async () => {
    const db = scriptedDatabase([], { at: "query", value: maliciousDriverError() });
    const store = new PgNativeSessionStore(db.sql);
    await expectRedacted(store.startSignIn(provider));
    expect(db.tx).toHaveBeenCalledTimes(1);
  });

  it("does not release a raw token or driver error when commit fails", async () => {
    const db = scriptedDatabase(completedExistingPersonRows(), { at: "commit", value: maliciousDriverError() });
    const store = new PgNativeSessionStore(db.sql);
    await expectRedacted(store.completeSignIn({ transactionId, claimToken: token, identity }));
    expect(db.tx).toHaveBeenCalled();
  });
});
