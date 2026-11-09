#!/usr/bin/env node
// mutinybim-mcp: the MutinyBIM tool server on your own computer (stdio or
// streamable HTTP). Scripts run in a fresh local process with the kit's caps;
// that runner is for one person's own scripts, never for hosting other
// people's. See docs/CONNECT-AN-AGENT.md.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const { parseArgs, startCli } = await import(new URL("../src/cli.ts", import.meta.url).href);

const options = parseArgs(process.argv.slice(2));
if ("error" in options) {
  process.stderr.write(`${options.error}\n`);
  process.exit(2);
}
// The add-on families are always on the server but off unless --packs names them; the agent can turn one on (bim_enable_pack).
const packsFor = (await import(new URL("../../bim-mcp-packs/src/local.ts", import.meta.url).href)).localToolPacks;
const started = await startCli(options, repoRoot, packsFor ? (host, dir) => [packsFor(host, dir)] : undefined);
const stop = () => {
  started.close().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`[mutinybim-mcp] stopping failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
