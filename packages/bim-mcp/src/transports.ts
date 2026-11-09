import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * The two transports: stdio (the agent client starts the server as a child
 * process: Claude Desktop, Claude Code, Cursor) and streamable HTTP (the
 * client connects to a URL: ChatGPT connectors, MCP Inspector, any HTTP
 * client). One server per session, so each connection has its own approvals
 * conversation with its client.
 */

/** Serves one session on this process's stdin/stdout. Logs go to stderr only (stdout is the protocol). */
export async function serveStdio(make: () => McpServer): Promise<McpServer> {
  const server = make();
  await server.connect(new StdioServerTransport());
  return server;
}

export interface HttpOptions {
  readonly port?: number;
  /** Default 127.0.0.1: this computer only. */
  readonly host?: string;
  /** Default /mcp. */
  readonly path?: string;
  /** Families served at /packs/<family>/mcp (the core plus that family). Default: none. */
  readonly families?: readonly string[];
}

/** Makes one session's server: with no families, the server's default; with families, the core plus those. */
export type MakeServer = (families?: readonly string[]) => McpServer;

export interface HttpServing {
  readonly url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : undefined);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/** Streamable HTTP at http://<host>:<port><path>, one session per client, DNS-rebinding protection on. */
export async function serveHttp(make: MakeServer, options: HttpOptions = {}): Promise<HttpServing> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/mcp";
  const families = new Set(options.families ?? []);
  /** The families a path serves: [] for the default path, [family] for /packs/<family>/mcp, null for anything else. */
  const route = (pathname: string): readonly string[] | null => {
    if (pathname === path) return [];
    const match = /^\/packs\/([a-z0-9-]+)\/mcp$/.exec(pathname);
    return match?.[1] && families.has(match[1]) ? [match[1]] : null;
  };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let allowedHosts: string[] = [];
  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      const served = route(url.pathname);
      if (served === null) return reply(res, 404, `Not found: the MCP endpoint is ${path}${families.size > 0 ? ` (or /packs/<family>/mcp for ${[...families].join(", ")})` : ""}.`);
      const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      const known = sessionId ? sessions.get(sessionId) : undefined;
      if (req.method === "POST") {
        const body = await readBody(req);
        if (known) return known.handleRequest(req, res, body);
        if (sessionId || !isInitializeRequest(body)) return reply(res, 400, "No session: start with an initialize request (or the session ended; reconnect).");
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
          enableDnsRebindingProtection: true,
          allowedHosts,
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await (served.length > 0 ? make(served) : make()).connect(transport);
        return transport.handleRequest(req, res, body);
      }
      if (req.method === "GET" || req.method === "DELETE") {
        if (!known) return reply(res, 400, "No such session.");
        return known.handleRequest(req, res);
      }
      return reply(res, 405, "Use POST, GET or DELETE.");
    })().catch((err: unknown) => {
      console.error("[bim-mcp] an HTTP request failed", err);
      if (!res.headersSent) reply(res, 500, err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, host, resolve));
  const { port } = http.address() as AddressInfo;
  allowedHosts = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`];
  return {
    url: `http://${host}:${port}${path}`,
    close: async () => {
      await Promise.all([...sessions.values()].map((t) => t.close().catch((err: unknown) => console.error("[bim-mcp] closing a session failed", err))));
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
