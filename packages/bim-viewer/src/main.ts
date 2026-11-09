/** Development baseline: the in-memory dev sequencer over its own WebSocket. */
import type { Actor } from "@permitzip/bim-kernel";
import { SyncClient } from "@permitzip/bim-sync";
import { startViewer } from "./app";

const params = new URLSearchParams(location.search);
const name = (params.get("name") ?? "").trim() || `Engineer ${Math.floor(Math.random() * 90 + 10)}`;
const actor: Actor = { id: `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`, name, kind: "human" };

void startViewer({
  name,
  backendLabel: "Dev baseline (in memory)",
  exportPdfUrl: "/export.pdf",
  async issue() {
    const res = await fetch("/issue", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("pdfUrl" in body) || !("revision" in body)) throw new Error("Unexpected issue response");
    return { pdfUrl: String(body.pdfUrl), revision: Number(body.revision) };
  },
  async dropNextNotification() {
    const res = await fetch("/debug/drop-next-broadcast", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  async createClient(events) {
    let socket: WebSocket | null = null;
    let backoff = 500;
    const client = new SyncClient(
      {
        send: (data) => {
          if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
        },
        close: () => socket?.close(),
      },
      actor,
      events,
    );
    const connect = async () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/sync`);
      socket.addEventListener("open", () => {
        backoff = 500;
        client.opened();
      });
      socket.addEventListener("message", (e) => client.receive(String(e.data)));
      socket.addEventListener("close", () => {
        client.closed();
        setTimeout(() => void connect(), backoff);
        backoff = Math.min(backoff * 2, 8000);
      });
      socket.addEventListener("error", (e) => console.error("[mutinybim] socket error", e));
    };
    return { client, connect };
  },
});
