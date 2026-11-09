/**
 * @jest-environment node
 */
import { type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { SyncClient } from "../src";

const FT = 304.8;

function liveClient(model: ModelState): { client: SyncClient; sent: string[] } {
  const sent: string[] = [];
  const client: SyncClient = new SyncClient(
    {
      send: (data) => {
        sent.push(data);
        if (JSON.parse(data).type === "hello") client.receive(JSON.stringify({ type: "welcome", model }));
      },
      close: () => undefined,
    },
    { id: "priya", name: "Priya", kind: "human" },
    {},
    60_000,
  );
  client.opened();
  return { client, sent };
}

describe("client predictions are computed once per confirmed head and pending list", () => {
  it("returns the same view until something changes, then recomputes", () => {
    const { client } = liveClient(createDemoModel());
    const first = client.view();
    expect(first).not.toBeNull();
    expect(client.view()).toBe(first);

    const submitted = client.submit({ type: "slide_branch", tapId: "tap-1", s: 10 * FT });
    expect(submitted.ok).toBe(true);
    const predicted = client.view();
    expect(predicted).not.toBe(first);
    const tap = predicted?.elements["tap-1"];
    expect(tap?.kind === "tap" ? tap.s : null).toBe(10 * FT);
    expect(client.view()).toBe(predicted);
    client.dispose();
  });
});
