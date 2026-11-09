/**
 * @jest-environment node
 *
 * Round 8b lane B: the model server serves a branch id wherever it serves the
 * branch's base, keeps the base's alias, and serves nothing for a branch of a
 * model it doesn't serve. Fails on round 8's code: `site-7161~abc` was not a
 * served id at all.
 */
import { servedModelId } from "../config";

const config = { servedModels: new Set(["demo"]), aliases: new Map([["old-demo", "demo"]]), servesOnDemand: (id: string) => /^site-[0-9]{3,6}$/.test(id) };

describe("b8-branch-ids", () => {
  it("serves branches of served models, under the base's stored id", () => {
    expect(servedModelId(config, "site-7161~abc123")).toBe("site-7161~abc123");
    expect(servedModelId(config, "demo~b1")).toBe("demo~b1");
    expect(servedModelId(config, "old-demo~b1")).toBe("demo~b1");
  });

  it("serves nothing for a branch of an unserved model or a malformed branch id", () => {
    expect(servedModelId({ servedModels: config.servedModels, aliases: config.aliases }, "site-7161~abc123")).toBeNull();
    expect(servedModelId(config, "nope~b1")).toBeNull();
    expect(servedModelId(config, "site-7161~a~b")).toBeNull();
    expect(servedModelId(config, "site-7161~bad id")).toBeNull();
  });
});
