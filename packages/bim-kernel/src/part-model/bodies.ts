import type { TriangleMesh } from "@permitzip/bim-geometry";
import type { DetailLevel } from "./schema";
import type { ImportedBodyRef } from "./schema-2";

/**
 * Imported bodies (a vendor's glTF or OBJ) reach the kernel through the host,
 * by content hash: the browser, worker or model server reads the stored file
 * once (bim-geometry `readBody`, sanitized and capped), decimates it for
 * coarse and medium drawings, and registers a source here. The kernel never
 * opens a file. A part whose body isn't loaded says so; it is never drawn as
 * an empty shape.
 */
export interface ImportedBodySource {
  /** The body in the part's frame (millimetres, z up) for one detail level, or null when the host hasn't loaded it. */
  body(ref: ImportedBodyRef, detail: DetailLevel): TriangleMesh | null;
}

let source: ImportedBodySource | null = null;

export function setImportedBodySource(next: ImportedBodySource | null): void {
  source = next;
}

export function importedBody(ref: ImportedBodyRef, detail: DetailLevel): TriangleMesh | null {
  return source ? source.body(ref, detail) : null;
}

/** A source over bodies already read, keyed by content hash (hosts and tests). */
export class ImportedBodyStore implements ImportedBodySource {
  private readonly bodies = new Map<string, Partial<Record<DetailLevel, TriangleMesh>> & { fine: TriangleMesh }>();

  /** Keep a body; `coarse` / `medium` default to the fine one. */
  put(contentHash: string, levels: Partial<Record<DetailLevel, TriangleMesh>> & { fine: TriangleMesh }): void {
    this.bodies.set(contentHash, levels);
  }

  has(contentHash: string): boolean {
    return this.bodies.has(contentHash);
  }

  body(ref: ImportedBodyRef, detail: DetailLevel): TriangleMesh | null {
    const b = this.bodies.get(ref.contentHash);
    if (!b) return null;
    return b[detail] ?? (detail === "coarse" ? b.medium : undefined) ?? b.fine;
  }
}
