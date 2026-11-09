/**
 * Starts the hosted MutinyBIM web app (see README.md for settings).
 *
 *   node --import tsx apps/mutinybim-web/src/server.ts      # http://127.0.0.1:3100
 */
import { createApp } from "./app";
import { readConfig } from "./config";

const config = readConfig();
const app = createApp(config);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[mutinybim-web] ${signal}: saving open models and stopping`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    console.error("[mutinybim-web] stopping cleanly failed", err);
    process.exit(1);
  }
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

app
  .listen()
  .then(() => {
    console.log(`[mutinybim-web] MutinyBIM at ${config.origin} (listening on ${config.host}:${config.port})`, {
      data: config.dataDir,
      signIn: ["email", ...config.providers.map((p) => p.id)],
      quote: config.quote ? config.quote.provider : "off",
      signup: config.signupOpen ? "open" : "closed",
      scripts: config.scripts?.mode ?? "sealed",
    });
  })
  .catch((err: unknown) => {
    console.error("[mutinybim-web] failed to start", err);
    process.exit(1);
  });
