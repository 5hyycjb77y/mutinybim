import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@permitzip/bim-kernel";
import type { ModelCreation, WebStore } from "./db";
import { starterModel, type StarterKind } from "./models";

type CreateResult = ModelCreation | "quota" | "conflict" | "busy";

function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileStat(file: string) {
  try {
    return await stat(file, { bigint: true });
  } catch (err) {
    if (hasCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The hosted app has one model volume, including when its accounts live in Postgres. */
export class ModelCreator {
  private readonly work: string;

  constructor(private readonly db: WebStore, private readonly volume: string) {
    this.work = path.join(volume, ".creating");
  }

  async create(owner: string, key: string, name: string, starter: StarterKind, limit: number): Promise<CreateResult> {
    const prior = await this.db.creationByKey(owner, key);
    if (prior) {
      if (prior.name !== name || prior.starter !== starter) return "conflict";
      return this.resume(prior);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = "m-" + randomBytes(10).toString("hex");
      const initial = canonicalJson(starterModel(id, starter));
      const result = await this.db.reserveCreation({ owner_id: owner, creation_key: key, model_id: id,
        name, starter, starter_hash: hash(initial), state: "reserved" }, limit);
      if (result === "id_used") continue;
      if (typeof result === "string") return result;
      return this.resume(result, result.model_id === id ? initial : undefined);
    }
    throw new Error("Could not allocate a unique model ID");
  }

  async recover(owner: string): Promise<void> {
    for (const row of await this.db.pendingCreations(owner)) {
      try {
        await this.resume(row);
      } catch (err) {
        console.error("[mutinybim-web] model creation is pending", { modelId: row.model_id, err });
      }
    }
  }

  async cancel(owner: string, key: string): Promise<ModelCreation | "busy" | null> {
    const row = await this.db.creationByKey(owner, key);
    return row ? this.resume(row, undefined, true) : null;
  }

  private async resume(row: ModelCreation, initial?: string, cancel = false): Promise<ModelCreation | "busy"> {
    if (!/^m-[a-f0-9]{20}$/.test(row.model_id)) throw new Error("Invalid reserved model ID");
    const stage = path.join(this.work, row.model_id + ".stage");
    let receipt = row.state === "reserved" ? undefined : row;
    let guard: DatabaseSync | undefined;
    try {
      if (receipt && !(await fileStat(stage))) return receipt;
      await mkdir(this.work, { recursive: true });
      // A dead worker releases this SQLite write lock. Keep the inode so a
      // second worker cannot accidentally lock a different file for this ID.
      guard = new DatabaseSync(path.join(this.work, row.model_id + ".lock"));
      try {
        guard.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      } catch (err) {
        if (typeof err === "object" && err !== null && "errcode" in err && err.errcode === 5) {
          const latest = receipt ?? await this.db.creationByKey(row.owner_id, row.creation_key);
          return latest && latest.state !== "reserved" ? latest : "busy";
        }
        throw err;
      }
      if (!receipt) {
        const current = await this.db.creationByKey(row.owner_id, row.creation_key);
        if (!current || current.model_id !== row.model_id) throw new Error("Model creation request no longer exists");
        if (current.state === "reserved") {
          const published = !cancel && await this.publish(current, stage, initial);
          receipt = await this.db.finishCreation(current.owner_id, current.creation_key, published ? "ready" : "abandoned");
        } else {
          receipt = current;
        }
      }
      // After an ambiguous database reply, a retry reads the receipt before touching the model.
      if (receipt.state === "abandoned") {
        const target = path.join(this.volume, row.model_id + ".json");
        const final = await fileStat(target);
        const owned = await fileStat(stage);
        if (final && owned && final.dev === owned.dev && final.ino === owned.ino) await unlink(target);
      }
      await unlink(stage).catch((err: unknown) => { if (!hasCode(err, "ENOENT")) throw err; });
      return receipt;
    } catch (err) {
      if (!receipt) throw err;
      console.error("[mutinybim-web] model creation cleanup is pending", { modelId: row.model_id, err });
      return receipt;
    } finally {
      guard?.close();
    }
  }

  private async publish(row: ModelCreation, stage: string, initial?: string): Promise<boolean> {
    const target = path.join(this.volume, row.model_id + ".json");
    const final = await fileStat(target);
    const staged = await fileStat(stage);
    if (final) {
      // A matching hash alone cannot establish ownership of a historical file.
      if (!staged || staged.dev !== final.dev || staged.ino !== final.ino) return false;
      if (hash(await readFile(stage)) !== row.starter_hash) throw new Error("The published starter failed its integrity check");
    } else {
      if (!staged || hash(await readFile(stage)) !== row.starter_hash) {
        const bytes = initial ?? canonicalJson(starterModel(row.model_id, row.starter));
        if (hash(bytes) !== row.starter_hash) return false;
        const handle = await open(stage, "w", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        // A previous process may have died after writing the stage but before syncing it.
        const handle = await open(stage, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
      }
      await syncDirectory(this.work);
      await link(stage, target);
    }
    await syncDirectory(this.volume);
    return true;
  }
}
