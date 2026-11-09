import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { readIfcSource, type IfcReadOptions } from "@permitzip/bim-ifc";
import type { ImportSource } from "@permitzip/bim-kernel";

/**
 * Fetch and read a linked model's IFC file (round 9 I9). The file comes only
 * from the host's storage through a short-lived signed address the host minted
 * after checking the person's access, and must hash to what the host recorded. The
 * read runs in a worker thread with its own heap limit, so a 150 MB file
 * never shares memory with the models this server is serving, and Cancel
 * stops it at once (the thread is terminated).
 */

export const MAX_IFC_BYTES = 150 * 1024 * 1024;
/** Peak heap for one read (perf row `ifc.import.convert`: peak worker memory ≤ 2 GB). */
export const CONVERT_HEAP_MB = 2048;

export const convertInputSchema = z.object({
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  read: z.object({
    sourceId: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    disciplines: z.array(z.string().min(1).max(100)).max(20),
    placement: z.object({ dx: z.number().finite(), dy: z.number().finite(), dz: z.number().finite(), rotationDeg: z.number().finite() }).optional(),
  }),
});

export type ConvertInput = { readonly url: string; readonly sha256: string; readonly read: Omit<IfcReadOptions, "isCancelled"> };

export class ConvertRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvertRefusal";
  }
}

/** Fetch, check and read, in this thread (the worker's body; tests and drills call it directly). */
export async function fetchAndRead(input: ConvertInput, fetchImpl: typeof fetch = fetch): Promise<ImportSource> {
  const res = await fetchImpl(input.url);
  if (!res.ok) throw new ConvertRefusal(`The linked model's file couldn't be fetched (${res.status}). Try again in a moment.`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IFC_BYTES) throw new ConvertRefusal("The linked model's file is over 150 MB, which this can't convert yet. Split the model, then link the parts.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IFC_BYTES) throw new ConvertRefusal("The linked model's file is over 150 MB, which this can't convert yet. Split the model, then link the parts.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== input.sha256) throw new ConvertRefusal("The linked model's file isn't the version that was linked (its fingerprint differs). Reload the page and try again.");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!/^\s*ISO-10303-21;/.test(text)) throw new ConvertRefusal("The linked model's file isn't an IFC file this can read (it doesn't start like one). Export it from its program as IFC, then link it again.");
  return readIfcSource(text, input.read);
}

export interface RunningConvert {
  readonly result: Promise<ImportSource>;
  cancel(): void;
}

/** Read in a worker thread. */
export function convertInThread(input: ConvertInput): RunningConvert {
  const worker = new Worker(new URL("./convert-thread.ts", import.meta.url), {
    workerData: input,
    execArgv: process.execArgv,
    resourceLimits: { maxOldGenerationSizeMb: CONVERT_HEAP_MB },
  });
  let cancelled = false;
  const result = new Promise<ImportSource>((resolve, reject) => {
    worker.once("message", (msg: { readonly ok: true; readonly source: ImportSource } | { readonly ok: false; readonly refused: boolean; readonly message: string }) => {
      if (msg.ok) resolve(msg.source);
      else reject(msg.refused ? new ConvertRefusal(msg.message) : new Error(msg.message));
      void worker.terminate();
    });
    worker.once("error", (err) => {
      console.error("[bim-authority/import] the conversion thread failed", { err });
      reject(err.message.includes("heap") || err.message.includes("memory") ? new ConvertRefusal("The linked model is too large to convert in one go (it ran out of memory). Split it, then link the parts.") : err);
    });
    worker.once("exit", (code) => {
      if (cancelled) reject(new ConvertRefusal("Stopped. Nothing was converted and Main didn't change."));
      else if (code !== 0) reject(new Error(`the conversion thread stopped with code ${code}`));
    });
  });
  return {
    result,
    cancel: () => {
      cancelled = true;
      void worker.terminate();
    },
  };
}
