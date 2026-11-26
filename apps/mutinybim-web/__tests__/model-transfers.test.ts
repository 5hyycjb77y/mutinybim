/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, type WebStore } from "../src/db";

let dir: string;
let db: WebStore;
let second: WebStore;
let file: string;
let offerId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bim-transfer-"));
  file = path.join(dir, "accounts.sqlite");
  db = openDb(file);
  second = openDb(file);
  for (const id of ["alex", "bea", "cam"]) {
    await db.createUser({ id, email: id + "@example.test", displayName: id, passwordHash: null });
  }
  await db.createModel({ id: "plant", ownerId: "alex", name: "Plant room" });
  await db.share({ modelId: "plant", userId: "bea", invitedBy: "alex", role: "view" });
  await db.share({ modelId: "plant", userId: "cam", invitedBy: "alex", role: "edit" });
  offerId = randomUUID();
});

afterEach(async () => {
  await second.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

test.each(["edit", "view", "none"] as const)("the recipient takes ownership and the sender keeps %s", async (retained) => {
  expect(await db.transfers.offer(offerId, "plant", "alex", "bea", retained)).toMatchObject({ state: "open" });
  const receipt = await second.transfers.respond(offerId, "bea", "accept", 1);
  expect(receipt).toMatchObject({ state: "accepted", accepted_at: expect.any(String) });
  expect((await db.accessTo("bea", "plant"))?.access).toBe("owner");
  expect((await db.accessTo("alex", "plant"))?.access ?? "none").toBe(retained);
  expect((await db.accessTo("cam", "plant"))?.access).toBe("edit");
  expect((await db.sharesOf("plant")).map((s) => s.user_id)).not.toContain("bea");
  await db.unshare("plant", "alex", "bea");
  expect(await db.transfers.respond(offerId, "bea", "accept", 1)).toEqual(receipt);
  expect(await db.accessTo("alex", "plant")).toBeNull();
  const raw = new DatabaseSync(file);
  try {
    raw.exec("PRAGMA foreign_keys = ON; DELETE FROM users WHERE id = 'alex'");
  } finally {
    raw.close();
  }
  expect((await db.accessTo("cam", "plant"))?.access).toBe("edit");
});

test("a role edit keeps an offer eligible, and a removed grant ends that offer permanently", async () => {
  await db.transfers.offer(offerId, "plant", "alex", "bea", "edit");
  expect(await db.transfers.offer(randomUUID(), "plant", "alex", "cam", "view")).toBe("exists");
  await second.share({ modelId: "plant", userId: "bea", invitedBy: "alex", role: "edit" });
  expect(await db.transfers.inbox("bea")).toHaveLength(1);
  await second.unshare("plant", "bea", "alex");
  await second.share({ modelId: "plant", userId: "bea", invitedBy: "alex", role: "view" });
  expect(await db.transfers.respond(offerId, "bea", "accept", 1)).toMatchObject({ state: "invalidated" });
  expect(await db.transfers.offer(randomUUID(), "plant", "alex", "bea", "edit")).toMatchObject({ state: "open" });
});

test.each(["cancelled", "declined", "expired"] as const)("a %s offer cannot change ownership on a later acceptance", async (state) => {
  await db.transfers.offer(offerId, "plant", "alex", "bea", "none");
  expect(await second.transfers.respond(offerId, "cam", "accept", 1)).toBe("unavailable");
  expect(await second.transfers.respond(offerId, "bea", "cancel", 1)).toBe("unavailable");
  expect(await second.transfers.respond(offerId, "alex", "decline", 1)).toBe("unavailable");
  if (state === "expired") {
    const raw = new DatabaseSync(file);
    try { raw.prepare("UPDATE model_transfers SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", offerId); }
    finally { raw.close(); }
  } else if (state === "cancelled") {
    expect(await db.transfers.respond(offerId, "alex", "cancel", 1)).toMatchObject({ state });
  } else {
    expect(await db.transfers.respond(offerId, "bea", "decline", 1)).toMatchObject({ state });
  }
  expect(await second.transfers.inbox("bea")).toEqual([]);
  expect(await second.transfers.respond(offerId, "bea", "accept", 1)).toMatchObject({ state, accepted_at: null });
  expect((await db.modelById("plant"))?.owner_id).toBe("alex");
  expect((await db.accessTo("bea", "plant"))?.access).toBe("view");
  expect(await db.transfers.offer(randomUUID(), "plant", "alex", "bea", "none")).toMatchObject({ state: "open" });
});

test("a populated legacy SQLite share gets a stable grant and can receive a handover after an upgrade", async () => {
  const legacyFile = path.join(dir, "legacy.sqlite");
  const baseline = new DatabaseSync(legacyFile);
  try {
    baseline.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
        password_hash TEXT, created_at TEXT NOT NULL);
      CREATE TABLE models (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE model_shares (model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('view','edit')),
        invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(model_id,user_id));
      INSERT INTO users VALUES ('x','x@example.test','X',NULL,'2026-10-01'),('y','y@example.test','Y',NULL,'2026-10-01');
      INSERT INTO models VALUES ('existing','x','Existing model','2026-10-01','2026-10-01');
      INSERT INTO model_shares VALUES ('existing','y','edit','x','2026-10-01');
    `);
  } finally { baseline.close(); }
  const upgraded = openDb(legacyFile);
  try {
    expect(await upgraded.transfers.offer(offerId, "existing", "x", "y", "edit")).toMatchObject({ state: "open", share_id: expect.any(String) });
  } finally { await upgraded.close(); }
  const reopened = openDb(legacyFile);
  try {
    expect(await reopened.transfers.respond(offerId, "y", "accept", 1)).toMatchObject({ state: "accepted" });
    expect((await reopened.accessTo("x", "existing"))?.access).toBe("edit");
    expect((await reopened.modelById("existing"))?.owner_id).toBe("y");
  } finally { await reopened.close(); }
});

test.each(["create", "accept"])("the last slot has one winner when %s is admitted first", async (winner) => {
  await db.transfers.offer(offerId, "plant", "alex", "bea", "edit");
  const req = { owner_id: "bea", creation_key: randomUUID(), model_id: "other", name: "New model",
    starter: "blank" as const, starter_hash: "a".repeat(64), state: "reserved" as const };
  if (winner === "create") {
    expect(await db.reserveCreation(req, 1)).toMatchObject({ state: "reserved" });
    expect(await second.transfers.respond(offerId, "bea", "accept", 1)).toBe("quota");
    expect(await second.transfers.inbox("bea")).toHaveLength(1);
    await db.finishCreation("bea", req.creation_key, "ready");
  } else {
    expect(await second.transfers.respond(offerId, "bea", "accept", 1)).toMatchObject({ state: "accepted" });
    expect(await db.reserveCreation(req, 1)).toBe("quota");
  }
  expect(await second.countModelsOf("bea")).toBe(1);
});

test("an interrupted acceptance rolls back the owner, grants and receipt together", async () => {
  await db.transfers.offer(offerId, "plant", "alex", "bea", "edit");
  const raw = new DatabaseSync(file);
  try {
    raw.exec("CREATE TRIGGER interrupt_handover BEFORE INSERT ON model_shares BEGIN SELECT RAISE(ABORT, 'stop handover'); END");
    await expect(second.transfers.respond(offerId, "bea", "accept", 1)).rejects.toThrow("stop handover");
    expect((await db.modelById("plant"))?.owner_id).toBe("alex");
    expect((await db.accessTo("bea", "plant"))?.access).toBe("view");
    expect(await db.transfers.outgoing("plant")).toMatchObject({ state: "open", accepted_at: null });
  } finally {
    raw.close();
  }
});

test("a creation cannot reuse the ID of a deleted legacy model mentioned in a receipt", async () => {
  await db.transfers.offer(offerId, "plant", "alex", "bea", "none");
  const receipt = await db.transfers.respond(offerId, "bea", "accept", 1);
  await db.deleteModel("plant", "bea");
  const key = randomUUID();
  expect(await second.reserveCreation({ owner_id: "cam", creation_key: key, model_id: "plant",
    name: "Different job", starter: "blank", starter_hash: "a".repeat(64), state: "reserved" }, 1)).toBe("id_used");
  expect(await db.creationByKey("cam", key)).toBeNull();
  expect(await db.transfers.respond(offerId, "bea", "accept", 1)).toEqual(receipt);
});
