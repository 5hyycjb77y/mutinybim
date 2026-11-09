/**
 * Load the synthetic full-BIM model the way the model server does: as plain
 * records parsed from storage, one row at a time, with no generator copy in the
 * process. A child process generates the model and streams it as one JSON line
 * per element (the authority's paged boot reads `elements.body` rows the same
 * way), so memory.server.heap / memory.server.rss measure the model server
 * only, not the harness's own copy of the model (product decision 8, round 8).
 *
 *   node --import tsx scripts/perf/mutinybim/server-load.ts --emit --tier=250k   (child mode)
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { elementCount, elementsFromRows, type BimElement, type Connection, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";

type Tier = keyof typeof FULL_BIM_TIERS;

interface HeaderLine {
  readonly header: Omit<ModelState, "elements" | "connections">;
  readonly generateMs: number;
  readonly elements: number;
  readonly connections: number;
}

export interface ServerLoad {
  readonly model: ModelState;
  /** Generation time in the child (the harness's cost, not the server's). */
  readonly generateMs: number;
  /** Wall time for the server process to read and parse every row. */
  readonly loadMs: number;
}

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

/** Child mode: generate, then write a header line, one line per element and one per connection. */
async function emit(tier: Tier): Promise<void> {
  // The generator is a host like the model server: the kernel carries no trade, so the tree's totals come from the first-party add-ons.
  installFirstPartyAddOns();
  const t0 = performance.now();
  const model = createFullBimModel(FULL_BIM_TIERS[tier]);
  const generateMs = performance.now() - t0;
  const { elements, connections, ...header } = model;
  const ids = Object.keys(elements);
  process.stdout.on("error", (err) => {
    console.error("[server-load] writing rows failed", err);
    process.exit(1);
  });
  const write = (line: string): Promise<void> =>
    new Promise((resolve) => {
      if (process.stdout.write(`${line}\n`)) resolve();
      else process.stdout.once("drain", resolve);
    });
  const first: HeaderLine = { header, generateMs, elements: ids.length, connections: connections.length };
  await write(JSON.stringify(first));
  // A page of rows per write, like the authority's boot pages.
  const PAGE = 2_000;
  let page: string[] = [];
  const flush = async (): Promise<void> => {
    if (page.length === 0) return;
    const text = page.join("\n");
    page = [];
    await write(text);
  };
  for (const id of ids) {
    page.push(JSON.stringify({ e: elements[id] }));
    if (page.length >= PAGE) await flush();
  }
  for (const c of connections) {
    page.push(JSON.stringify({ c }));
    if (page.length >= PAGE) await flush();
  }
  await flush();
}

function parseHeader(line: string): HeaderLine {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || !("header" in parsed) || !("elements" in parsed) || !("connections" in parsed) || !("generateMs" in parsed)) {
    throw new Error("[server-load] the child's first line is not a model header");
  }
  return parsed as HeaderLine;
}

/** Parent mode: spawn the generator and build the head from its rows. */
export async function loadModelLikeServer(tier: Tier): Promise<ServerLoad> {
  // __dirname: tsx runs these scripts as CommonJS (no "type": "module"), and so does Jest.
  const self = path.join(__dirname, "server-load.ts");
  const child = spawn(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", self, "--emit", `--tier=${tier}`], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`[server-load] generator exited with ${code ?? signal}`))));
  });
  const t0 = performance.now();
  // Rows first, then one record, as pg-store.ts builds the head from its boot pages.
  const rows: BimElement[] = [];
  const connections: Connection[] = [];
  let head: HeaderLine | null = null;
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line.length === 0) continue;
    if (head === null) {
      head = parseHeader(line);
      continue;
    }
    const row = JSON.parse(line) as { e?: BimElement; c?: Connection };
    if (row.e) rows.push(row.e);
    else if (row.c) connections.push(row.c);
    else throw new Error("[server-load] a row is neither an element nor a connection");
  }
  await exited;
  if (head === null) throw new Error("[server-load] the generator wrote nothing");
  const elements = elementsFromRows(rows);
  rows.length = 0;
  const count = elementCount(elements);
  if (count !== head.elements || connections.length !== head.connections) {
    throw new Error(`[server-load] read ${count} elements / ${connections.length} connections, the generator wrote ${head.elements} / ${head.connections}`);
  }
  return { model: { ...head.header, elements, connections }, generateMs: head.generateMs, loadMs: performance.now() - t0 };
}

const argv = process.argv.slice(2);
if (argv.includes("--emit")) {
  const tier = argv.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "";
  if (!isTier(tier)) {
    console.error(`[server-load] --tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
    process.exit(2);
  }
  emit(tier).catch((err) => {
    console.error("[server-load] generator failed", err);
    process.exit(1);
  });
}
