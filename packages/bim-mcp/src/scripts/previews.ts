import { createHash } from "node:crypto";
import { canonicalJson } from "@permitzip/bim-kernel";
import { scriptReadsSchema, type ScriptReads } from "@permitzip/bim-library";

/**
 * Scripts kept between calls, so an agent sends a script once.
 *
 * Every script an agent sends inline (to check it or preview it) is kept
 * under a short id. Later calls name the id instead of sending the text
 * again: a preview after a check, a fix after an error (the id plus exact
 * replacements) and the approved call that lands a preview.
 *
 * What an id is bound to:
 *
 * - The id is a hash of the person, the script's text and its reads. A
 *   different text, different reads or another person gives another id, and
 *   a kept record whose contents no longer hash to its id is not used.
 * - Only the person who sent the script can use its id.
 * - A successful preview is noted on the record with what it ran with (the
 *   project and model, the area, the values, the selection) and the hash of
 *   its output. Landing by id runs exactly that again and lands only that
 *   output; a call that names other values, another area or another model
 *   is refused.
 *
 * Where records live is the host's (`ScriptPreviewStore`): approvals can
 * wait a day on a hosted product, so a host keeps them somewhere that
 * outlives a restart. `MemoryScriptPreviewStore` is for one person's own
 * computer. A host that gives no store gets the old answers: the preview
 * returns the whole script in apply_with.args.
 */

/** How long a kept script (and its previews) can be used: longer than a day, so an approval that waited overnight still lands. */
export const KEPT_SCRIPT_KEEP_MS = 36 * 60 * 60_000;
/** Previews remembered per script (the newest win). */
export const KEPT_PREVIEWS_MAX = 8;
export const KEPT_SCRIPT_ID = /^scr_[a-f0-9]{32}$/;
export const SCRIPT_EXPIRED_WORDS = "That preview has expired; run the script again (send the whole script to bim_run_script once more).";

export type KeptValues = Readonly<Record<string, string | number | boolean>>;

/** One successful preview of a kept script: what it ran with and what it made. */
export interface KeptPreview {
  readonly projectId: string;
  readonly modelId: string | null;
  readonly level: string | null;
  readonly zone: string | null;
  readonly values: KeptValues;
  readonly selection: readonly string[] | null;
  readonly outputHash: string;
  /** Milliseconds since 1970. */
  readonly at: number;
}

export interface KeptScript {
  readonly id: string;
  /** The person the script was sent for (`ScriptLibrary.callerId`). */
  readonly ownerId: string;
  readonly source: string;
  readonly reads: ScriptReads;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly previews: readonly KeptPreview[];
}

/**
 * Where kept scripts live. A host stores each record whole (JSON) under its
 * id and gives it back unchanged; the tools check the owner, the expiry and
 * the id themselves, so a store needs no rules of its own.
 */
export interface ScriptPreviewStore {
  /** Saves the record under its id, replacing an earlier one. */
  put(script: KeptScript): Promise<void>;
  /** The record, or null when there is none (a store may also drop records past `expiresAt`). */
  get(id: string): Promise<KeptScript | null>;
}

export function keptScriptId(ownerId: string, source: string, reads: ScriptReads): string {
  return `scr_${createHash("sha256").update(canonicalJson({ ownerId, source, reads })).digest("hex").slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValues(value: unknown): value is KeptValues {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
}

function parsePreview(value: unknown): KeptPreview | null {
  if (!isRecord(value)) return null;
  const { projectId, modelId, level, zone, values, selection, outputHash, at } = value;
  if (typeof projectId !== "string" || typeof outputHash !== "string" || typeof at !== "number" || !isValues(values)) return null;
  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const ids = Array.isArray(selection) ? selection.filter((s): s is string => typeof s === "string") : null;
  return { projectId, modelId: text(modelId), level: text(level), zone: text(zone), values, selection: ids, outputHash, at };
}

/** A record read back from a durable store (JSON), or null when it isn't one. */
export function parseKeptScript(value: unknown): KeptScript | null {
  if (!isRecord(value)) return null;
  const { id, ownerId, source, createdAt, expiresAt } = value;
  const reads = scriptReadsSchema.safeParse(value.reads);
  if (typeof id !== "string" || typeof ownerId !== "string" || typeof source !== "string" || typeof createdAt !== "number" || typeof expiresAt !== "number" || !reads.success) return null;
  const previews = Array.isArray(value.previews) ? value.previews.flatMap((p) => parsePreview(p) ?? []) : [];
  return { id, ownerId, source, reads: reads.data, createdAt, expiresAt, previews };
}

/**
 * The kept script `id` as `ownerId` may use it now, or null: no record, past
 * its time, another person's, or a record that no longer hashes to its id.
 * One answer for all four, so an id tells a stranger nothing.
 */
export async function readKeptScript(store: ScriptPreviewStore, ownerId: string, id: string, now: number): Promise<KeptScript | null> {
  if (!KEPT_SCRIPT_ID.test(id)) return null;
  const found = parseKeptScript(await store.get(id));
  if (!found || found.id !== id || found.ownerId !== ownerId || found.expiresAt <= now) return null;
  if (keptScriptId(found.ownerId, found.source, found.reads) !== id) {
    console.error("[bim-mcp] a kept script doesn't match its id, so it wasn't used", { id });
    return null;
  }
  return found;
}

/** Keeps a script (again: its time starts over and its previews stay) and returns the record. */
export async function keepScript(store: ScriptPreviewStore, ownerId: string, source: string, reads: ScriptReads, now: number): Promise<KeptScript> {
  const id = keptScriptId(ownerId, source, reads);
  const before = await readKeptScript(store, ownerId, id, now);
  const record: KeptScript = { id, ownerId, source, reads, createdAt: before?.createdAt ?? now, expiresAt: now + KEPT_SCRIPT_KEEP_MS, previews: before?.previews ?? [] };
  await store.put(record);
  return record;
}

const sameRun = (a: KeptPreview, b: Pick<KeptPreview, "projectId" | "modelId" | "outputHash">) => a.projectId === b.projectId && a.modelId === b.modelId && a.outputHash === b.outputHash;

/** Notes a successful preview on its script (the newest first, the same run once). */
export async function notePreview(store: ScriptPreviewStore, script: KeptScript, preview: KeptPreview): Promise<KeptScript> {
  const record: KeptScript = { ...script, expiresAt: preview.at + KEPT_SCRIPT_KEEP_MS, previews: [preview, ...script.previews.filter((p) => !sameRun(p, preview))].slice(0, KEPT_PREVIEWS_MAX) };
  await store.put(record);
  return record;
}

/** The preview of this script on this project and model that made this output, or null. */
export function previewOf(script: KeptScript, run: Pick<KeptPreview, "projectId" | "modelId" | "outputHash">): KeptPreview | null {
  return script.previews.find((p) => sameRun(p, run)) ?? null;
}

/** One exact replacement in a kept script's text. */
export interface ScriptReplacement {
  readonly old: string;
  readonly new: string;
  /** Replace every place `old` appears (default: it must appear exactly once). */
  readonly all?: boolean | undefined;
}

function shown(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
}

function linesOf(source: string, needle: string, max: number): number[] {
  const out: number[] = [];
  let at = source.indexOf(needle);
  while (at >= 0 && out.length < max) {
    out.push(source.slice(0, at).split("\n").length);
    at = source.indexOf(needle, at + needle.length);
  }
  return out;
}

/**
 * A script's text with exact replacements made in order. Refused, naming the
 * replacement and what to do, when an `old` text isn't in the script or is
 * there more than once (without `all`); nothing is changed then.
 */
export function applyReplacements(source: string, replace: readonly ScriptReplacement[]): { readonly ok: true; readonly source: string } | { readonly ok: false; readonly message: string } {
  let text = source;
  for (const [index, r] of replace.entries()) {
    const which = `Replacement ${index + 1} ("${shown(r.old)}")`;
    if (r.old === r.new) return { ok: false, message: `${which} changes nothing: old and new are the same text.` };
    const count = text.split(r.old).length - 1;
    if (count === 0) {
      return { ok: false, message: `${which} wasn't made: that text isn't in the script${index > 0 ? " after the replacements before it" : ""}. old must match the script exactly, spaces and line breaks included; copy it from the script you sent. Nothing was changed.` };
    }
    if (count > 1 && !r.all) {
      return { ok: false, message: `${which} wasn't made: that text is in the script ${count} times (lines ${linesOf(text, r.old, 6).join(", ")}). Give more of the text around the one place you mean, or add all: true to change every one. Nothing was changed.` };
    }
    text = text.split(r.old).join(r.new);
  }
  return { ok: true, source: text };
}

/** How many kept scripts, and how much text, one process holds (the oldest go first). */
const MEMORY_MAX_SCRIPTS = 300;
const MEMORY_MAX_CHARS = 20_000_000;

/**
 * Kept scripts in this process's memory: for one person's own computer, and
 * for tests. Nothing survives a restart, so a preview made before one is
 * answered "expired". A hosted product supplies a durable store instead.
 */
export class MemoryScriptPreviewStore implements ScriptPreviewStore {
  private readonly records = new Map<string, KeptScript>();
  private chars = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async put(script: KeptScript): Promise<void> {
    this.drop(script.id);
    const at = this.now();
    for (const [id, record] of this.records) if (record.expiresAt <= at) this.drop(id);
    this.records.set(script.id, script);
    this.chars += script.source.length;
    for (const id of this.records.keys()) {
      if (this.records.size <= MEMORY_MAX_SCRIPTS && this.chars <= MEMORY_MAX_CHARS) break;
      if (id !== script.id) this.drop(id);
    }
  }

  async get(id: string): Promise<KeptScript | null> {
    const found = this.records.get(id);
    if (!found) return null;
    if (found.expiresAt <= this.now()) {
      this.drop(id);
      return null;
    }
    return found;
  }

  get size(): number {
    return this.records.size;
  }

  private drop(id: string): void {
    const before = this.records.get(id);
    if (!before) return;
    this.chars -= before.source.length;
    this.records.delete(id);
  }
}
