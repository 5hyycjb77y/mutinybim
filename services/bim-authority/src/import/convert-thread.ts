import { parentPort, workerData } from "node:worker_threads";
import { ConvertRefusal, convertInputSchema, fetchAndRead } from "./convert";

/** The conversion thread's body: one read, its answer posted back, then the thread ends. */
const input = convertInputSchema.parse(workerData);
fetchAndRead(input)
  .then((source) => parentPort?.postMessage({ ok: true, source }))
  .catch((err: unknown) => {
    console.error("[bim-authority/import] reading the linked model failed", { url: input.url.replace(/\?.*$/, ""), err });
    parentPort?.postMessage({ ok: false, refused: err instanceof ConvertRefusal, message: err instanceof Error ? err.message : String(err) });
  });
