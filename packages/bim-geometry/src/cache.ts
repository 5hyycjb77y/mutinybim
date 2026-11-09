import type { ConvexPieces, SolidEngine, SolidProgram, TriangleMesh } from "./program";

/**
 * Meshes by content key. A thousand placed parts of one size ask for the same
 * key and get the same mesh object back; the engine runs once. Least recently
 * used entries go first when the cache is full. Convex pieces (clash) are kept
 * the same way under the same key, built only when something asks for them.
 */
export class MeshCache {
  private readonly entries = new Map<string, TriangleMesh>();
  private readonly pieceEntries = new Map<string, ConvexPieces>();
  private evaluationCount = 0;
  private pieceCount = 0;

  constructor(
    private readonly engine: SolidEngine,
    private readonly capacity = 512,
  ) {}

  /** The mesh for `key`, building it from `program()` only when it isn't cached. */
  get(key: string, program: () => SolidProgram): TriangleMesh {
    return this.lru(this.entries, key, () => {
      this.evaluationCount++;
      return this.engine.evaluate(program());
    });
  }

  /** The convex pieces for `key`, building them from `program()` only when they aren't cached. */
  pieces(key: string, program: () => SolidProgram): ConvexPieces {
    return this.lru(this.pieceEntries, key, () => {
      this.pieceCount++;
      return this.engine.convexPieces(program());
    });
  }

  private lru<T>(map: Map<string, T>, key: string, make: () => T): T {
    const hit = map.get(key);
    if (hit !== undefined) {
      map.delete(key);
      map.set(key, hit);
      return hit;
    }
    const value = make();
    map.set(key, value);
    if (map.size > this.capacity) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    return value;
  }

  /** How many times the engine actually ran (tests and perf checks). */
  get evaluations(): number {
    return this.evaluationCount;
  }

  /** How many times convex pieces were actually built. */
  get pieceEvaluations(): number {
    return this.pieceCount;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.pieceEntries.clear();
  }
}
