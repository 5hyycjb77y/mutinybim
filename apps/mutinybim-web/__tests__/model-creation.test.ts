/** @jest-environment node */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@permitzip/bim-kernel";
import { openDb, type ModelCreation, type WebStore } from "../src/db";
import { ModelCreator } from "../src/model-creation";
import { ModelStore, starterModel } from "../src/models";

let dir: string;
let db: WebStore;
let creator: ModelCreator;
let row: ModelCreation;
let bytes: string;
let stage: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bim-create-"));
  db = openDb(path.join(dir, "accounts.sqlite"));
  await db.createUser({ id: "bea", email: "bea@example.test", displayName: "Bea", passwordHash: null });
  creator = new ModelCreator(db, dir);
  const id = "m-00112233445566778899";
  bytes = canonicalJson(starterModel(id, "blank"));
  row = { owner_id: "bea", creation_key: randomUUID(), model_id: id, name: "Plant", starter: "blank",
    starter_hash: createHash("sha256").update(bytes).digest("hex"), state: "reserved" };
  await db.reserveCreation(row, 1);
  await mkdir(path.join(dir, ".creating"));
  stage = path.join(dir, ".creating", id + ".stage");
  target = path.join(dir, id + ".json");
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

test.each(["partial stage", "published file"])("a fresh store resumes a %s exactly once", async (phase) => {
  await writeFile(stage, phase === "published file" ? bytes : bytes.slice(0, 15));
  if (phase === "published file") await link(stage, target);
  expect(await db.modelsOf("bea")).toHaveLength(0);
  await db.close();
  db = openDb(path.join(dir, "accounts.sqlite"));
  const restarted = new ModelCreator(db, dir);
  await restarted.recover("bea");
  await restarted.recover("bea");
  expect((await db.modelsOf("bea")).map((m) => m.id)).toEqual([row.model_id]);
  expect((await new ModelStore(dir).head(row.model_id)).modelId).toBe(row.model_id);
  expect(await db.pendingCreations("bea")).toEqual([]);
});

test("recovery leaves equal historical bytes with a different inode in place", async () => {
  await writeFile(stage, bytes);
  await writeFile(target, bytes);
  const original = await stat(target, { bigint: true });
  await creator.recover("bea");
  expect(await db.creationByKey("bea", row.creation_key)).toMatchObject({ state: "abandoned" });
  expect(await db.modelsOf("bea")).toHaveLength(0);
  expect((await stat(target, { bigint: true })).ino).toBe(original.ino);
  expect(await readFile(target, "utf8")).toBe(bytes);
});

test("a saved creation receipt is available while another worker finishes cleanup", async () => {
  await writeFile(stage, bytes);
  await link(stage, target);
  const receipt = await db.finishCreation("bea", row.creation_key, "ready");
  const held = new DatabaseSync(path.join(dir, ".creating", row.model_id + ".lock"));
  try {
    held.exec("BEGIN IMMEDIATE");
    expect(await creator.create("bea", row.creation_key, "Plant", "blank", 1)).toEqual(receipt);
  } finally {
    held.close();
  }
  expect(await creator.create("bea", row.creation_key, "Plant", "blank", 1)).toEqual(receipt);
  await expect(stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(target, "utf8")).toBe(bytes);
});

test("a live reservation holds its slot, survives a second writer, and can be cancelled", async () => {
  const held = new DatabaseSync(path.join(dir, ".creating", row.model_id + ".lock"));
  try {
    held.exec("BEGIN IMMEDIATE");
    await writeFile(stage, "still writing");
    await creator.recover("bea");
    expect(await creator.cancel("bea", row.creation_key)).toBe("busy");
    expect(await readFile(stage, "utf8")).toBe("still writing");
    expect(await creator.create("bea", randomUUID(), "Plant", "blank", 1)).toBe("quota");
  } finally {
    held.close();
  }
  expect(await creator.cancel("bea", row.creation_key)).toMatchObject({ state: "abandoned" });
  expect(await creator.create("bea", row.creation_key, "Plant", "blank", 1)).toMatchObject({ state: "abandoned" });
  expect(await creator.create("bea", randomUUID(), "Plant", "blank", 1)).toMatchObject({ state: "ready" });
});
