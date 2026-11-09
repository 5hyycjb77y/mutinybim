import { contentHashOf, makeItem } from "@permitzip/bim-library";
import type { LibrarySaveResult, ScriptLibrary, StoredPartTypeItem, StoredScriptItem } from "../host";

/**
 * A script library in memory, for one person on their own computer: the
 * scripts and part types they save while the server runs. Every script is
 * theirs, so no reuse approval is needed; nothing survives a restart (keep
 * the source yourself, or publish it to a hosted library).
 *
 * A script version is fixed once saved (new content needs a new version); a
 * part type saved again with new content becomes its next revision.
 */
interface Entry<T> {
  readonly stored: T;
  readonly hash: string;
  readonly revision: number;
}

export class MemoryScriptLibrary {
  private readonly scriptItems = new Map<string, Entry<StoredScriptItem>>();
  private readonly partItems = new Map<string, Entry<StoredPartTypeItem>>();

  constructor(private readonly person: string) {}

  /** The library as the script tools read it. `writable: false` refuses saves in words. */
  forCaller(writable = true): ScriptLibrary {
    return {
      callerId: this.person,
      firmWrite: writable ? { allowed: true } : { allowed: false, reason: "this tool server is read-only (--read-only)." },
      scripts: async () => [...this.scriptItems.values()].map((e) => e.stored),
      partTypes: async () => [...this.partItems.values()].map((e) => e.stored),
      saveScript: async (scope, script) => save(this.scriptItems, `${scope}/${script.key}@${script.version}`, { scope, body: script }, contentHashOf(makeItem("script", script)), "fixed"),
      savePartTypesFromRun: async (scope, items) => items.map((item) => save(this.partItems, `${scope}/${item.key}`, { scope, body: item }, contentHashOf(makeItem("part_type", item)), "revised")),
      approvals: { approvalOf: async () => null },
    };
  }
}

function save<T>(into: Map<string, Entry<T>>, id: string, stored: T, hash: string, changes: "fixed" | "revised"): LibrarySaveResult {
  const before = into.get(id);
  if (before?.hash === hash) return { status: "up_to_date", id, revision: before.revision };
  if (before && changes === "fixed") return { status: "refused", code: "conflict", message: `${id} is already saved with different content; save it as a new version.` };
  const revision = (before?.revision ?? 0) + 1;
  into.set(id, { stored, hash, revision });
  return { status: "saved", summary: { revision }, because: [before ? "new content" : "new in this library"] };
}
