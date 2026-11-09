/**
 * @jest-environment node
 *
 * The tool server's startup log names the model server it connects to; a
 * hosted model server's address carries the person's access key, which the
 * log must never show.
 */
import { redactAddress } from "../src/cli";

describe("redactAddress", () => {
  it("hides an access key or token in the address and keeps the rest", () => {
    expect(redactAddress("wss://app.example/sync?key=mbk_secret123&model=m-1")).toBe("wss://app.example/sync?key=…&model=m-1");
    expect(redactAddress("wss://app.example/sync?model=m-1&TOKEN=abc")).toBe("wss://app.example/sync?model=m-1&TOKEN=…");
    expect(redactAddress("ws://127.0.0.1:3095/sync")).toBe("ws://127.0.0.1:3095/sync");
  });
});
