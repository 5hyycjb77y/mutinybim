import { ISSUED_FOLDER, type DrawingSetFiles } from "./capabilities";

/** A memory link reports the same lifetime a signed link would. */
const SIGNED_URL_SECONDS = 300;

/** In-memory set storage with the same answers as a host's (tests and the local drill). */
export function memoryDrawingSetFiles(): DrawingSetFiles & { readonly files: Map<string, Uint8Array>; readonly filed: Map<string, string> } {
  const files = new Map<string, Uint8Array>();
  const created = new Map<string, number>();
  const filed = new Map<string, string>();
  let clock = 0;
  const link = async (path: string) => ({ downloadUrl: `https://storage.test/${path}`, expiresInSeconds: SIGNED_URL_SECONDS });
  return {
    files,
    filed,
    async put(path, bytes) {
      const existed = files.has(path);
      if (!existed) {
        files.set(path, bytes);
        created.set(path, clock++);
      }
      return { existed, ...(await link(path)) };
    },
    async list(folder, limit) {
      const prefix = `${folder.replace(/\/$/, "")}/`;
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .sort((a, b) => (created.get(b) ?? 0) - (created.get(a) ?? 0))
        .slice(0, limit)
        .map((p) => ({ name: p.slice(prefix.length), createdAt: new Date(created.get(p) ?? 0).toISOString() }));
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    link,
    async fileInProject({ storagePath, name }) {
      const already = filed.get(storagePath);
      if (already) return { status: "already_filed", fileId: storagePath, folder: ISSUED_FOLDER, name: already };
      filed.set(storagePath, name);
      return { status: "filed", fileId: storagePath, folder: ISSUED_FOLDER, name };
    },
  };
}
