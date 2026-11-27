/** Disposable native-install.py fixture. Provider verification ends at this fixture's input. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { PgNativeSessionStore } from "../src/native-session-store";
import { connect } from "../src/pg-store";
import { signIn } from "./native-drill-signin";

const [phase, privateFile] = process.argv.slice(2);
const url = process.env.MUTINYBIM_NATIVE_DRILL_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/native_drill" ||
    !privateFile || (phase !== "issue" && phase !== "reopen")) {
  throw new Error("Run the disposable database drill with native-install.py");
}

const sql = connect(url);
const sessions = new PgNativeSessionStore(sql);

try {
  if (phase === "issue") {
    const owner = await signIn(sessions, "Drill owner");
    const coworker = await signIn(sessions, "Drill coworker");
    const short = await signIn(new PgNativeSessionStore(sql, { sessionTtlSeconds: 1 }), "Drill coworker");
    assert.equal(short.personId, coworker.personId);
    assert.equal((await sessions.resolveSession(coworker.sessionToken))?.personId, coworker.personId);
    await sessions.revokeSession(coworker.sessionToken);
    const coworkerAgain = await signIn(sessions, "Drill coworker");
    assert.equal(coworkerAgain.personId, coworker.personId);
    const active = await sessions.resolveSession(owner.sessionToken);
    assert.equal(active?.personId, owner.personId);
    // Only the parent drill's private temp directory carries bearer values across the restart.
    writeFileSync(privateFile, JSON.stringify({
      active: owner.sessionToken, coworker: coworkerAgain.sessionToken, revoked: coworker.sessionToken,
      short: short.sessionToken, shortId: short.sessionId,
    }), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ owner: active.personId, coworker: coworker.personId }));
  } else {
    const saved = JSON.parse(readFileSync(privateFile, "utf8"));
    const active = await sessions.resolveSession(saved.active);
    assert.ok(active, "The original owner session must survive restart");
    assert.equal(await sessions.resolveSession(saved.revoked), null);
    // Wait on the same database clock the store uses, even on a fast restart.
    const expiry = await sql`select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp())))::float8)
      from bim.native_sessions where session_id = ${saved.shortId}::uuid and revoked_at is null`;
    assert.equal(expiry.length, 1);
    assert.equal(await sessions.resolveSession(saved.short), null);
    const again = await signIn(sessions, "Drill owner");
    assert.equal(again.personId, active.personId);
    console.log(JSON.stringify({ owner: active.personId }));
  }
} finally {
  await sql.end();
}
