import { access, constants, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LibraryFileSystem } from "./file-provider";

const DENIED = new Set(["ENOENT", "EACCES", "EPERM", "EROFS"]);

/** null when writable; the denial's code otherwise. Other errors throw. */
async function accessCode(path: string): Promise<string | null> {
  try {
    await access(path, constants.W_OK);
    return null;
  } catch (err) {
    if (err instanceof Error && "code" in err && typeof err.code === "string" && DENIED.has(err.code)) return err.code;
    throw err;
  }
}

/** `LibraryFileSystem` over Node's file system, for the standalone server and desktop hosts. */
export function nodeLibraryFileSystem(): LibraryFileSystem {
  return {
    readText: (path) => readFile(path, "utf8"),
    listDir: (path) => readdir(path),
    writeText: (path, text) => writeFile(path, text, "utf8"),
    /** An existing file or folder: whether it is writable. A file not created yet: whether its folder is. */
    async canWrite(path) {
      const code = await accessCode(path);
      if (code === "ENOENT") return (await accessCode(dirname(path))) === null;
      return code === null;
    },
  };
}
